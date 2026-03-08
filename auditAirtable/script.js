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

  // Rally artifact type(s) to audit — string or array of strings.
  // Must match the recordType(s) used in queryRally/script.js for this table.
  recordType: "HierarchicalRequirement", // "HierarchicalRequirement" | "PortfolioItem/Feature" | "Defect" | "Task" | etc.
  // recordType: ["PortfolioItem/Feature", "HierarchicalRequirement"],

  // Project scoping — mirrors queryRally/script.js CONFIG.project.
  // The audit compares Airtable records against the same Rally scope used during sync.
  project: {
    mode: "single",               // "single" | "multiple" | "workspace"
    ref: "/project/12345678910",  // used for "single"
    refs: [],                     // used for "multiple" — array of project ref strings
    scopeDown: false,             // include child projects
  },

  // Additional Rally filters — use the same values as queryRally/script.js to ensure
  // the audit checks the same scope that was used to populate Airtable.
  filters: [],

  pageSize: 2000, // Rally WSAPI max; Airtable caps scripts at 50 fetch calls (50 × 2000 = 100k records)

  airtable: {
    tableId: "tblXXXXXXXXXXXXXX",

    // Field containing the Rally FormattedID (e.g. "F123456", "US789")
    rallyIdFieldId: "fldXXXXXXXXXXXXXX",

    // Single select field to stamp on Airtable records whose Rally record is no longer found
    statusFieldId: "fldXXXXXXXXXXXXXX",

    // Value to write into statusFieldId — must already exist as an option in the field
    statusValue: "Inactive",

    // Source field filter — use when multiple sources share the same ID format (e.g. "F######").
    // When set, only Airtable records where sourceFieldId equals sourceFilterValue are audited.
    // Set sourceFieldId to null to audit all records that have a non-empty Rally ID field.
    sourceFieldId: "fldXXXXXXXXXXXXXX", // single select field identifying the record's source
    sourceFilterValue: "Rally",          // only audit records with this source value

    // Optional extra Airtable formula clause to further filter which records are audited.
    // This is AND'd together with the Rally ID and source field clauses automatically.
    // Example: "NOT({Status} = \"Archived\")"
    // Set to null if no additional filtering is needed.
    filterByFormula: null,
  },

}; // end CONFIG

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

// --- Rally fetch (single project scope or workspace) -------------------------

async function fetchPage(recordType, params, start) {
  // Build URL as a raw (non-percent-encoded) string — Rally's query parser does not decode encoded query strings.
  const orderedParams = { query: null, order: null, fetch: null, project: null, projectScopeDown: null, ...params, start: String(start), pagesize: String(CONFIG.pageSize) };
  const paramStr = Object.entries(orderedParams)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const url = `${CONFIG.rally.baseUrl}/${recordType.toLowerCase()}/?${paramStr}`;

  console.log(`Rally request: ${url}`);
  const response = await fetch(url, {
    headers: { "ZSESSIONID": CONFIG.rally.apiKey },
  });

  if (!response.ok) {
    throw new Error(`Rally query failed: ${response.status} ${await response.text()}`);
  }

  const json = await response.json();
  const result = json.QueryResult;

  if (result.Errors && result.Errors.length > 0) {
    throw new Error(`Rally query errors: ${result.Errors.join(", ")}`);
  }

  return {
    records: result.Results ?? [],
    total: result.TotalResultCount ?? 0,
  };
}

async function fetchAll(recordType, baseParams) {
  const records = [];
  let start = 1;

  while (true) {
    const { records: page, total } = await fetchPage(recordType, baseParams, start);
    records.push(...page);
    if (records.length >= total || page.length === 0) break;
    start += CONFIG.pageSize;
  }

  return records;
}

// --- Project scope helpers ---------------------------------------------------

async function fetchDescendantProjectIds(parentRef) {
  const parentId = parentRef.split("/").pop();
  const ids = [parentId];

  async function collectChildren(id) {
    const url = new URL(`${CONFIG.rally.baseUrl}/project`);
    url.searchParams.set("fetch", "ObjectID,Children");
    url.searchParams.set("query", `(Parent.ObjectID = "${id}")`);
    url.searchParams.set("pagesize", "2000");
    url.searchParams.set("start", "1");
    const response = await fetch(url.toString(), {
      headers: { "ZSESSIONID": CONFIG.rally.apiKey },
    });
    if (!response.ok) throw new Error(`Project discovery failed: ${response.status} ${await response.text()}`);
    const children = (await response.json()).QueryResult?.Results ?? [];
    for (const child of children) {
      ids.push(String(child.ObjectID));
      if ((child.Children?.Count ?? 0) > 0) {
        await collectChildren(String(child.ObjectID));
      }
    }
  }

  await collectChildren(parentId);
  console.log(`Discovered ${ids.length} projects under ${parentRef}`);
  return ids;
}

function buildProjectFilterGroup(projectIds) {
  return {
    groupLogic: "OR",
    group: projectIds.map(id => ({ field: "Project.ObjectID", operator: "=", value: id })),
  };
}

// --- Airtable fetch ----------------------------------------------------------

async function fetchAirtableRecordsWithRallyId() {
  const { rallyIdFieldId, sourceFieldId, sourceFilterValue, filterByFormula } = CONFIG.airtable;

  // Build a single server-side filterByFormula by AND-ing all active clauses together.
  // Field IDs in curly braces are supported by Airtable's formula engine.
  const clauses = [];
  clauses.push(`{${rallyIdFieldId}} != ""`);
  if (sourceFieldId) {
    clauses.push(`{${sourceFieldId}} = "${sourceFilterValue}"`);
  }
  if (filterByFormula) {
    clauses.push(filterByFormula);
  }
  const formula = clauses.length === 1 ? clauses[0] : `AND(${clauses.join(", ")})`;

  const fields = [rallyIdFieldId];
  if (sourceFieldId) fields.push(sourceFieldId);

  const table = base.getTable(CONFIG.airtable.tableId);
  const result = await table.selectRecordsAsync({ fields, filterByFormula: formula });

  return result.records.map(r => ({
    id: r.id,
    rallyId: r.getCellValueAsString(rallyIdFieldId).trim(),
  }));
}

// --- Airtable batch update ---------------------------------------------------

async function batchUpdateAirtableRecords(recordIds) {
  if (recordIds.length === 0) return;

  const table = base.getTable(CONFIG.airtable.tableId);
  const BATCH_SIZE = 50;

  for (let i = 0; i < recordIds.length; i += BATCH_SIZE) {
    const batch = recordIds.slice(i, i + BATCH_SIZE);
    const updates = batch.map(id => ({
      id,
      fields: { [CONFIG.airtable.statusFieldId]: { name: CONFIG.airtable.statusValue } },
    }));

    if (CONFIG.dryRun) {
      console.log(`[DRY RUN] Would update ${batch.length} Airtable records:`, batch);
    } else {
      await table.updateRecordsAsync(updates);
      console.log(`Updated batch of ${batch.length} Airtable records (${i + batch.length}/${recordIds.length} total)`);
    }
  }
}

// --- Rally FormattedID fetch -------------------------------------------------
// Mirrors the project-mode logic from queryRally/script.js but only fetches
// FormattedID — no other fields, no ordering needed for an audit.

async function fetchAllRallyFormattedIds() {
  const fetchFields = "FormattedID";
  const { mode, ref, refs, scopeDown } = CONFIG.project;

  const recordTypes = Array.isArray(CONFIG.recordType)
    ? CONFIG.recordType
    : [CONFIG.recordType];

  const allIds = [];
  const seen   = new Set();

  async function runQuery(params) {
    for (const recordType of recordTypes) {
      const records = await fetchAll(recordType, params);
      for (const record of records) {
        if (!seen.has(record._ref)) {
          seen.add(record._ref);
          if (record.FormattedID) allIds.push(record.FormattedID);
        }
      }
    }
  }

  if (mode === "workspace") {
    const queryString = buildQueryString(CONFIG.filters);
    const queryParam  = queryString ? { query: queryString } : {};
    await runQuery({ fetch: fetchFields, ...queryParam });

  } else if (mode === "single") {
    if (scopeDown) {
      const projectIds  = await fetchDescendantProjectIds(ref);
      const scopedQuery = buildQueryString([...CONFIG.filters, buildProjectFilterGroup(projectIds)]);
      const queryParam  = scopedQuery ? { query: scopedQuery } : {};
      await runQuery({ fetch: fetchFields, ...queryParam });
    } else {
      const queryString = buildQueryString(CONFIG.filters);
      const queryParam  = queryString ? { query: queryString } : {};
      await runQuery({
        fetch:            fetchFields,
        project:          `${CONFIG.rally.baseUrl}${ref}`,
        projectScopeDown: "false",
        ...queryParam,
      });
    }

  } else if (mode === "multiple") {
    if (scopeDown) {
      const allProjectIds = [];
      const seenIds       = new Set();
      for (const projectRef of refs) {
        for (const id of await fetchDescendantProjectIds(projectRef)) {
          if (!seenIds.has(id)) { seenIds.add(id); allProjectIds.push(id); }
        }
      }
      const scopedQuery = buildQueryString([...CONFIG.filters, buildProjectFilterGroup(allProjectIds)]);
      const queryParam  = scopedQuery ? { query: scopedQuery } : {};
      await runQuery({ fetch: fetchFields, ...queryParam });
    } else {
      const queryString = buildQueryString(CONFIG.filters);
      const queryParam  = queryString ? { query: queryString } : {};
      for (const projectRef of refs) {
        for (const recordType of recordTypes) {
          const records = await fetchAll(recordType, {
            fetch:            fetchFields,
            project:          `${CONFIG.rally.baseUrl}${projectRef}`,
            projectScopeDown: "false",
            ...queryParam,
          });
          for (const record of records) {
            if (!seen.has(record._ref)) {
              seen.add(record._ref);
              if (record.FormattedID) allIds.push(record.FormattedID);
            }
          }
        }
      }
    }

  } else {
    throw new Error(`Unknown project.mode: "${mode}". Use "single", "multiple", or "workspace".`);
  }

  return allIds;
}

// --- Main --------------------------------------------------------------------

async function main() {
  console.log("=== auditAirtable starting ===");
  console.log(`dryRun: ${CONFIG.dryRun}`);

  // Step 1: Fetch Airtable records that have a Rally ID (and match the source filter if set)
  console.log("Step 1: Fetching Airtable records with Rally IDs...");
  const airtableRecords = await fetchAirtableRecordsWithRallyId();
  console.log(`Found ${airtableRecords.length} Airtable records to audit`);

  if (airtableRecords.length === 0) {
    console.log("Nothing to audit. Exiting.");
    return;
  }

  // Step 2: Fetch all FormattedIDs currently in Rally scope
  console.log("Step 2: Fetching all Rally records in scope...");
  const rallyFormattedIds = await fetchAllRallyFormattedIds();
  const rallyIdSet = new Set(rallyFormattedIds);
  console.log(`Found ${rallyIdSet.size} Rally records in scope`);

  // Step 3: Identify stale Airtable records
  console.log("Step 3: Identifying stale Airtable records...");
  const stale = airtableRecords.filter(r => !rallyIdSet.has(r.rallyId));
  console.log(`Found ${stale.length} stale Airtable records (Rally ID not found in scope)`);

  if (stale.length > 0) {
    console.log("Stale Rally IDs:", stale.map(r => r.rallyId).join(", "));
  }

  // Step 4: Mark stale records
  console.log(`Step 4: Setting "${CONFIG.airtable.statusValue}" on ${stale.length} stale records...`);
  await batchUpdateAirtableRecords(stale.map(r => r.id));

  // Summary
  console.log("=== auditAirtable complete ===");
  console.log(`  Airtable records audited:  ${airtableRecords.length}`);
  console.log(`  Rally records in scope:    ${rallyIdSet.size}`);
  console.log(`  Stale records found:       ${stale.length}`);
  console.log(`  Records updated:           ${CONFIG.dryRun ? 0 : stale.length} (dryRun=${CONFIG.dryRun})`);
}

await main();
