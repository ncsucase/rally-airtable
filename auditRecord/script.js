// Paste this script into the "Run a script" action inside a Repeating Group.
// The Repeating Group must be configured to iterate over the "auditRecord" output
// from auditAirtable/script.js.
//
// For each Airtable record, this script queries Rally to determine whether the
// record still exists and — in three-state mode — whether it still matches the
// configured project scope and filters. It then stamps the Airtable record with
// the appropriate status.

// --- Date helpers (use these as filter value functions) ----------------------

function daysAgo(n)   { return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10); }
function weeksAgo(n)  { return daysAgo(n * 7); }
function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

// -----------------------------------------------------------------------------

const CONFIG = {

  dryRun: false,

  rally: {
    baseUrl: "https://rally1.rallydev.com/slm/webservice/v2.0",
    apiKey: "YOUR_RALLY_API_KEY",
  },

  // Rally artifact type — must match the recordType used to populate Airtable.
  recordType: "HierarchicalRequirement", // "HierarchicalRequirement" | "PortfolioItem/Feature" | "Defect" | "Task" | etc.
  // recordType: ["PortfolioItem/Feature", "HierarchicalRequirement"],

  // Project scope for the "in-scope" check — used only in three-state mode.
  // Must match the project settings used in queryRally/script.js for this table.
  // Not needed in binary mode (when statusValue is set, or statusGone === statusOutOfScope).
  project: {
    mode: "single",               // "single" | "multiple" | "workspace"
    ref: "/project/12345678910",  // used for "single"
    refs: [],                     // used for "multiple" — array of project ref strings
    scopeDown: false,             // include child projects
  },

  // Filters for the "in-scope" check — used only in three-state mode.
  // Must match the filters used in queryRally/script.js to populate this table.
  filters: [],

  airtable: {
    tableId: "tblXXXXXXXXXXXXXX",

    // Single select field to stamp on Airtable records based on their audit state.
    // All values used must already exist as options in the field before running.
    statusFieldId: "fldXXXXXXXXXXXXXX",

    // THREE-STATE mode — set distinct values to classify each state.
    // Set any to null to skip updating that bucket.
    statusGone:       "Removed from Rally", // record deleted from Rally entirely
    statusOutOfScope: "Out of Scope",       // record exists in Rally but no longer matches criteria
    statusCurrent:    null,                 // record still matches; null = skip

    // BINARY mode — set statusValue instead of the three keys above.
    // Any record not found anywhere in Rally is marked with this value.
    // statusValue: "Inactive",
  },

  // Optional — fetch Rally field values and write them to Airtable in the same pass.
  // Only fields listed here are fetched; omit entirely to keep the script audit-only.
  // Enrichment is written for "current" and "outOfScope" states (whenever a Rally record
  // is found); no enrichment is written for "gone" records.
  fieldMappings: [
    // { rallyField: "Name",                airtableFieldId: "fldXXX", airtableFieldType: "singleLineText" },
    // { rallyField: "Owner.DisplayName",   airtableFieldId: "fldXXX", airtableFieldType: "singleLineText" },
    // { rallyField: r => r.State?.Name,    rallyFetch: "State",       airtableFieldId: "fldXXX", airtableFieldType: "singleSelect" },
    // { rallyField: "Owner.DisplayName", airtableFieldId: "fldXXX", airtableFieldType: "linkedRecord",
    //   linkedRecord: {
    //     linkedTableId: "tblXXX",
    //     lookup: { fieldId: "fldXXX", rallyValue: r => r.Owner?.EmailAddress },
    //     createIfMissing: { fields: { "fldNAMEXXX": r => r.Owner?.DisplayName, "fldEMAILXXX": r => r.Owner?.EmailAddress } },
    //   },
    //   nullHandling: "ignore" },
    //
    // Optional per-mapping keys:
    //   rallyFetch   — required only when rallyField is a function; names the top-level Rally field to request
    //   transform    — function applied to the raw Rally value before writing, e.g. v => v?.toUpperCase()
    //   nullHandling — "writeNull" (default) | "ignore" (skip if null) | "mapToValue" (write nullValue)
    //   nullValue    — fallback written when nullHandling is "mapToValue"
    //
    // Supported airtableFieldType values:
    //   singleLineText, multilineText, url, email, phoneNumber,
    //   number, currency, percent, rating, checkbox,
    //   date, dateTime, singleSelect, multipleSelect, richText, linkedRecord
  ],

}; // end CONFIG

// --- Config normalization ----------------------------------------------------
// Detects binary vs. three-state mode and backfills old-style statusValue configs.
//
// Binary mode:    statusGone === statusOutOfScope.
//                 One workspace-wide Rally call per record — no project config needed.
//
// Three-state mode: statusGone !== statusOutOfScope.
//                   Up to two Rally calls per record:
//                   1. Scoped check (project + filters) → "current" if found.
//                   2. Workspace-wide check → "outOfScope" or "gone".
//                   Requires CONFIG.project and CONFIG.filters to match queryRally.

(function normalizeStatusConfig() {
  const a = CONFIG.airtable;
  const hasNewKeys = ("statusGone" in a) || ("statusOutOfScope" in a) || ("statusCurrent" in a);
  if (!hasNewKeys && a.statusValue) {
    a.statusGone       = a.statusValue;
    a.statusOutOfScope = a.statusValue;
    a.statusCurrent    = null;
  }
  if (!("statusGone"       in a)) a.statusGone       = null;
  if (!("statusOutOfScope" in a)) a.statusOutOfScope = null;
  if (!("statusCurrent"    in a)) a.statusCurrent    = null;
  a._threeState = (a.statusGone !== a.statusOutOfScope);
})();

// --- Field enrichment helpers ------------------------------------------------

// Builds the Rally fetch= param from fieldMappings. Always includes FormattedID.
function buildFetchParam() {
  const base = ["FormattedID"];
  if (!CONFIG.fieldMappings?.length) return base[0];
  const extra = CONFIG.fieldMappings.map(m =>
    typeof m.rallyField === "function" ? (m.rallyFetch ?? null) : m.rallyField.split(".")[0]
  ).filter(Boolean);
  return [...new Set([...base, ...extra])].join(",");
}

function getRallyValue(record, rallyField) {
  if (typeof rallyField === "function") return rallyField(record);
  return rallyField.split(".").reduce((obj, key) => obj?.[key] ?? null, record);
}

function coerceForAirtable(value, fieldType) {
  if (value === null || value === undefined) return null;
  switch (fieldType) {
    case "singleLineText": case "multilineText":
    case "url": case "email": case "phoneNumber":
      return String(value);
    case "number": case "currency": case "percent": case "rating":
      return Number(value);
    case "checkbox":
      return Boolean(value);
    case "date":
      return new Date(value).toISOString().slice(0, 10);
    case "dateTime":
      return new Date(value).toISOString();
    case "singleSelect":
      return String(value);
    case "multipleSelect":
      return Array.isArray(value) ? value.map(String) : [String(value)];
    case "richText":
      return htmlToMarkdown(String(value));
    default:
      return String(value);
  }
}

function applyNullHandling(value, mapping) {
  const isNull = value === null || value === undefined || (Array.isArray(value) && value.length === 0);
  if (!isNull) return value;
  switch (mapping.nullHandling ?? "writeNull") {
    case "ignore":     return undefined; // sentinel — caller skips this field
    case "mapToValue": return mapping.nullValue ?? null;
    case "writeNull":
    default:           return null;
  }
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function convertTableToMarkdown(tableHtml) {
  let s = tableHtml;
  s = s.replace(/<colgroup[^>]*>[\s\S]*?<\/colgroup>/gi, "");
  s = s.replace(/<\/?(thead|tbody|tfoot)[^>]*>/gi, "");
  const rowMatches = [...s.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const rows = [];
  for (const [, rowInner] of rowMatches) {
    const cells = [];
    for (const [, cellInner] of rowInner.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)) {
      cells.push(decodeHtmlEntities(cellInner.replace(/<[^>]+>/g, "")).trim());
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return "";
  const colCount = Math.max(...rows.map(r => r.length));
  const separator = "|" + Array(colCount).fill("---|").join("");
  const mdRows = rows.map(cells => {
    while (cells.length < colCount) cells.push("");
    return "| " + cells.join(" | ") + " |";
  });
  mdRows.splice(1, 0, separator);
  return "\n\n" + mdRows.join("\n") + "\n\n";
}

function htmlToMarkdown(html) {
  if (!html) return "";
  let s = html;
  s = s.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    const code = inner.replace(/<code[^>]*>/gi, "").replace(/<\/code>/gi, "");
    return "\n```\n" + decodeHtmlEntities(code.trim()) + "\n```\n";
  });
  s = s.replace(/<a[^>]+href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  s = s.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**");
  s = s.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**");
  s = s.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*");
  s = s.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "*$1*");
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  s = s.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  s = s.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  s = s.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => {
    let n = 0;
    return inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (__, item) => `\n${++n}. ${item}`) + "\n";
  });
  s = s.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner) =>
    inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1") + "\n"
  );
  s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, inner) => convertTableToMarkdown(inner));
  s = s.replace(/<\/?figure[^>]*>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n\n");
  s = s.replace(/<\/div>/gi, "\n");
  s = s.replace(/<\/blockquote>/gi, "\n");
  s = s.replace(/<img[^>]+>/gi, imgTag => {
    const alt = (imgTag.match(/alt=["']([^"']*?)["']/i) ?? [])[1];
    const src = (imgTag.match(/src=["']([^"']+)["']/i) ?? [])[1] ?? "";
    const name = alt?.trim() || src.split("/").pop().split("?")[0] || "image";
    return `[Image: ${name}]`;
  });
  s = s.replace(/<[^>]+>/g, "");
  s = decodeHtmlEntities(s);
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

async function resolveLinkedRecord(rallyRecord, mapping) {
  const { linkedRecord } = mapping;
  const matchValue = typeof linkedRecord.lookup.rallyValue === "function"
    ? linkedRecord.lookup.rallyValue(rallyRecord)
    : getRallyValue(rallyRecord, linkedRecord.lookup.rallyValue);

  if (matchValue === null || matchValue === undefined || matchValue === "") {
    const nh = mapping.nullHandling ?? "writeNull";
    if (nh === "ignore") return undefined;
    if (nh === "mapToValue") return mapping.nullValue ?? null;
    return null;
  }

  const matchStr = String(matchValue);
  const table    = base.getTable(linkedRecord.linkedTableId);
  const query    = await table.selectRecordsAsync({ fields: [linkedRecord.lookup.fieldId] });
  const match    = query.records.find(
    r => r.getCellValueAsString(linkedRecord.lookup.fieldId) === matchStr
  );

  if (match) return [{ id: match.id }];

  if (linkedRecord.createIfMissing) {
    const newFields = {};
    for (const [fieldId, extractor] of Object.entries(linkedRecord.createIfMissing.fields ?? {})) {
      const val = typeof extractor === "function" ? extractor(rallyRecord) : extractor;
      if (val !== null && val !== undefined) newFields[fieldId] = String(val);
    }
    const newId = await table.createRecordAsync(newFields);
    console.log(`  Created linked record: ${matchStr}`);
    return [{ id: newId }];
  }

  const nh = mapping.nullHandling ?? "writeNull";
  if (nh === "ignore") return undefined;
  if (nh === "mapToValue") return mapping.nullValue ?? null;
  return null;
}

async function buildEnrichmentUpdates(rallyRecord) {
  if (!CONFIG.fieldMappings?.length || !rallyRecord) return {};
  const updates = {};
  for (const mapping of CONFIG.fieldMappings) {
    if (mapping.airtableFieldType === "linkedRecord") {
      const value = await resolveLinkedRecord(rallyRecord, mapping);
      if (value === undefined) continue;
      updates[mapping.airtableFieldId] = value;
      continue;
    }
    const raw         = getRallyValue(rallyRecord, mapping.rallyField);
    const transformed = mapping.transform ? mapping.transform(raw) : raw;
    const handled     = applyNullHandling(transformed, mapping);
    if (handled === undefined) continue;
    updates[mapping.airtableFieldId] = coerceForAirtable(handled, mapping.airtableFieldType);
  }
  return updates;
}

// --- Query builder -----------------------------------------------------------

function buildQueryString(filters) {
  if (!filters || filters.length === 0) return null;

  function resolveValue(v) {
    return typeof v === "function" ? v() : v;
  }

  function formatValue(v) {
    return (v === null || v === undefined) ? '""' : `"${v}"`;
  }

  function buildClause(entry) {
    if (entry.group) {
      const subClauses = entry.group.map(c =>
        `(${c.field} ${c.operator} ${formatValue(resolveValue(c.value))})`
      );
      const gl = (entry.groupLogic ?? "or").toLowerCase();
      return subClauses.reduce((acc, c) => acc ? `(${acc} ${gl} ${c})` : c);
    }
    return `(${entry.field} ${entry.operator} ${formatValue(resolveValue(entry.value))})`;
  }

  let result = buildClause(filters[0]);
  for (let i = 1; i < filters.length; i++) {
    const op = (filters[i].logicalOp ?? "and").toLowerCase();
    result = `(${result} ${op} ${buildClause(filters[i])})`;
  }
  return result;
}

// --- Rally existence check ---------------------------------------------------

// Builds the WSAPI query string for a specific FormattedID, optionally adding
// CONFIG.filters and an additional condition (e.g. a project OR clause).
function buildCheckQuery(rallyId, extraFilter = null) {
  let query = `(FormattedID = "${rallyId}")`;
  const filterStr = buildQueryString(CONFIG.filters);
  if (filterStr) query = `(${query} AND ${filterStr})`;
  if (extraFilter) query = `(${query} AND ${extraFilter})`;
  return query;
}

// Fires a single Rally request and returns { found, record } where record is the
// first matching Rally object (populated per buildFetchParam) or null.
// query       — pre-built WSAPI query string (not URL-encoded)
// extraParams — optional { project, projectScopeDown } URL params
async function checkExists(query, extraParams = {}) {
  const recordTypes = Array.isArray(CONFIG.recordType) ? CONFIG.recordType : [CONFIG.recordType];

  for (const recordType of recordTypes) {
    // Build URL as a raw (non-percent-encoded) string — Rally's query parser
    // does not decode percent-encoded query strings.
    const orderedParams = {
      query,
      fetch: buildFetchParam(),
      project: null,
      projectScopeDown: null,
      ...extraParams,
      start: "1",
      pagesize: "1",
    };
    const paramStr = Object.entries(orderedParams)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const url = `${CONFIG.rally.baseUrl}/${recordType.toLowerCase()}/?${paramStr}`;

    console.log(`Rally request: ${url}`);
    const response = await fetch(url, { headers: { "ZSESSIONID": CONFIG.rally.apiKey } });
    if (!response.ok) throw new Error(`Rally query failed: ${response.status} ${await response.text()}`);

    const json = await response.json();
    const result = json.QueryResult;
    if (result.Errors?.length > 0) throw new Error(`Rally errors: ${result.Errors.join(", ")}`);
    if ((result.TotalResultCount ?? 0) > 0) return { found: true, record: result.Results?.[0] ?? null };
  }

  return { found: false, record: null };
}

// Checks if the record exists AND matches the configured project scope + filters.
// Used only in three-state mode.
async function checkInScope(rallyId) {
  const { mode, ref, refs, scopeDown } = CONFIG.project;

  if (mode === "workspace") {
    // Workspace scope: apply user filters but no project constraint.
    return await checkExists(buildCheckQuery(rallyId));

  } else if (mode === "single") {
    return await checkExists(buildCheckQuery(rallyId), {
      project: `${CONFIG.rally.baseUrl}${ref}`,
      projectScopeDown: scopeDown ? "true" : "false",
    });

  } else if (mode === "multiple") {
    if (!scopeDown) {
      // Build an OR clause from project IDs extracted from the refs array.
      // No extra Rally calls needed — the IDs are embedded in the ref strings.
      const projectIds = refs.map(r => r.split("/").pop());
      const projectFilter = projectIds
        .map(id => `(Project.ObjectID = "${id}")`)
        .reduce((a, b) => `(${a} OR ${b})`);
      return await checkExists(buildCheckQuery(rallyId, projectFilter));
    } else {
      // scopeDown: use Rally's projectScopeDown param, one call per project ref.
      for (const projectRef of refs) {
        const result = await checkExists(buildCheckQuery(rallyId), {
          project: `${CONFIG.rally.baseUrl}${projectRef}`,
          projectScopeDown: "true",
        });
        if (result.found) return result;
      }
      return { found: false, record: null };
    }

  } else {
    throw new Error(`Unknown project.mode: "${mode}". Use "single", "multiple", or "workspace".`);
  }
}

// Checks if the record exists anywhere in Rally — no project scope, no user filters.
async function checkExistsAnywhere(rallyId) {
  return await checkExists(`(FormattedID = "${rallyId}")`);
}

// --- Classification ----------------------------------------------------------

async function classifyRecord(rallyId) {
  const { _threeState } = CONFIG.airtable;

  if (!_threeState) {
    // Binary mode: single workspace-wide existence check.
    const result = await checkExistsAnywhere(rallyId);
    return { state: result.found ? "current" : "gone", record: result.record };
  }

  // Three-state mode: scoped check first (1 call), workspace-wide only if needed (1 call).
  const inScopeResult = await checkInScope(rallyId);
  if (inScopeResult.found) return { state: "current", record: inScopeResult.record };

  const anywhereResult = await checkExistsAnywhere(rallyId);
  return {
    state: anywhereResult.found ? "outOfScope" : "gone",
    record: anywhereResult.record,
  };
}

// --- Main --------------------------------------------------------------------

async function main() {
  // input.config() may only be called once per script execution — destructure both values together.
  const { rallyId, recordId } = input.config();
  const { statusGone, statusOutOfScope, statusCurrent, _threeState } = CONFIG.airtable;

  console.log(`Auditing ${rallyId} (${_threeState ? "three-state" : "binary"} mode)...`);

  const { state, record } = await classifyRecord(rallyId);
  const statusValue = { current: statusCurrent, outOfScope: statusOutOfScope, gone: statusGone }[state];

  const airtableUpdates = {};
  if (statusValue) airtableUpdates[CONFIG.airtable.statusFieldId] = { name: statusValue };
  Object.assign(airtableUpdates, await buildEnrichmentUpdates(record));

  if (Object.keys(airtableUpdates).length === 0) {
    console.log(`${rallyId} → ${state} → no update`);
    return;
  }

  if (CONFIG.dryRun) {
    console.log(`[DRY RUN] ${rallyId} → ${state} → would update: ${JSON.stringify(airtableUpdates)}`);
  } else {
    const table = base.getTable(CONFIG.airtable.tableId);
    await table.updateRecordAsync(recordId, airtableUpdates);
    console.log(`${rallyId} → ${state} → updated ${Object.keys(airtableUpdates).length} field(s)`);
  }
}

await main();
