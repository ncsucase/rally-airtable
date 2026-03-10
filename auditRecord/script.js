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

// Fires a single Rally request and returns true if any matching record exists.
// query       — pre-built WSAPI query string (not URL-encoded)
// extraParams — optional { project, projectScopeDown } URL params
async function checkExists(query, extraParams = {}) {
  const recordTypes = Array.isArray(CONFIG.recordType) ? CONFIG.recordType : [CONFIG.recordType];

  for (const recordType of recordTypes) {
    // Build URL as a raw (non-percent-encoded) string — Rally's query parser
    // does not decode percent-encoded query strings.
    const orderedParams = {
      query,
      fetch: "FormattedID",
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
    if ((result.TotalResultCount ?? 0) > 0) return true;
  }

  return false;
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
        const found = await checkExists(buildCheckQuery(rallyId), {
          project: `${CONFIG.rally.baseUrl}${projectRef}`,
          projectScopeDown: "true",
        });
        if (found) return true;
      }
      return false;
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
    const exists = await checkExistsAnywhere(rallyId);
    return exists ? "current" : "gone";
  }

  // Three-state mode: scoped check first (1 call), workspace-wide only if needed (1 call).
  const inScope = await checkInScope(rallyId);
  if (inScope) return "current";

  const existsAnywhere = await checkExistsAnywhere(rallyId);
  return existsAnywhere ? "outOfScope" : "gone";
}

// --- Main --------------------------------------------------------------------

async function main() {
  // input.config() may only be called once per script execution — destructure both values together.
  const { rallyId, recordId } = input.config();
  const { statusGone, statusOutOfScope, statusCurrent, _threeState } = CONFIG.airtable;

  console.log(`Auditing ${rallyId} (${_threeState ? "three-state" : "binary"} mode)...`);

  const state = await classifyRecord(rallyId);
  const statusValue = { current: statusCurrent, outOfScope: statusOutOfScope, gone: statusGone }[state];

  if (statusValue) {
    if (CONFIG.dryRun) {
      console.log(`[DRY RUN] ${rallyId} → ${state} → would set "${statusValue}"`);
    } else {
      const table = base.getTable(CONFIG.airtable.tableId);
      await table.updateRecordAsync(recordId, {
        [CONFIG.airtable.statusFieldId]: { name: statusValue },
      });
      console.log(`${rallyId} → ${state} → set "${statusValue}"`);
    }
  } else {
    console.log(`${rallyId} → ${state} → no update (statusValue is null)`);
  }
}

await main();
