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

  rally: {
    baseUrl: "https://rally1.rallydev.com/slm/webservice/v2.0",
    apiKey: "YOUR_RALLY_API_KEY",
  },

  // Rally artifact type(s) to query — string or array of strings
  // When an array is given, all types share the same project scope, filters, and order.
  // For different project scopes per type, use separate queryRally scripts chained in the automation.
  recordType: "HierarchicalRequirement", // "HierarchicalRequirement" | "PortfolioItem/Feature" | "Defect" | "Task" | etc.
  // recordType: ["PortfolioItem/Feature", "HierarchicalRequirement"],

  // Project scoping
  project: {
    mode: "single",               // "single" | "multiple" | "workspace"
    ref: "/project/12345678910",  // used for "single"
    refs: [],                     // used for "multiple" — array of project ref strings
    scopeDown: false,             // include child projects ("single" and each ref in "multiple")
  },

  // Filters
  // Each entry is a plain condition or a group of conditions.
  // logicalOp on any entry controls how it connects to the previous entry (default "AND").
  // value can be a static string or a function that returns a string at runtime.
  // operators: "=" | "!=" | "<" | "<=" | ">" | ">=" | "contains" | "!contains"
  filters: [
    // Plain condition:
    // { field: "Owner.Name", operator: "=", value: "Jane Smith" },

    // Plain condition OR'd with the previous:
    // { field: "Owner.Name", operator: "=", value: "Bob Smith", logicalOp: "OR" },

    // Group — conditions inside combined by groupLogic (default "AND"), then AND'd with outer:
    // {
    //   groupLogic: "OR",
    //   group: [
    //     { field: "ScheduleState",        operator: "=",  value: "Defined"                },
    //     { field: "ScheduleState",        operator: "=",  value: "In-Progress"            },
    //   ],
    // },

    // Group with relative date, OR'd with the outer accumulated result:
    // {
    //   logicalOp: "OR",
    //   groupLogic: "AND",
    //   group: [
    //     { field: "Release.ReleaseStartDate", operator: ">=", value: () => monthsAgo(6) },
    //     { field: "Release.Name",             operator: "!=", value: "Unscheduled"      },
    //   ],
    // },

    // Empty/null check — use value: null (JS null) to produce = "" in the query:
    // { field: "Release", operator: "=", value: null },
  ],

  // Rally fields to retrieve — only request what compare.js actually reads
  fetch: [
    "FormattedID",
    "Name",
    "ScheduleState",
    "Owner",
    "Project",
    "Tags",
    "LastUpdateDate",
    "Iteration",
    "Release",
  ],

  pageSize: 2000, // Rally WSAPI v2.0 max; Airtable caps scripts at 50 fetch calls (50 × 2000 = 100k records)

  // Sort order — applied to all queries
  order: [
    // { field: "Release.ReleaseStartDate", direction: "ASC"  },
    // { field: "Rank",                     direction: "ASC"  },
    // { field: "LastUpdateDate",           direction: "DESC" },
    // direction: "ASC" | "DESC"  (default: "ASC")
  ],

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

function buildOrderString(order) {
  if (!order || order.length === 0) return null;
  return order.map(o => `${o.field} ${o.direction ?? "ASC"}`).join(",");
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

// --- Record trimmer ----------------------------------------------------------
// Collapses nested Rally object references to identifying fields only,
// keeping the output payload small enough for Airtable's output.set() limit.

const SLIM_FIELDS = ["ObjectID", "Name", "DisplayName", "FormattedID", "EmailAddress", "_type", "_refObjectName", "_ref"];

// Slims a Rally object reference to identifying fields only.
// Also preserves one level of nested Rally sub-objects (e.g. Project.Parent),
// so extractor functions in compare.js can read r.Project?.Parent?._refObjectName
// without a separate Rally API call.
function slimRallyObject(value) {
  const slim = {};
  for (const f of SLIM_FIELDS) {
    if (value[f] !== undefined) slim[f] = value[f];
  }
  for (const [k, v] of Object.entries(value)) {
    if (slim[k] !== undefined) continue; // already captured above
    if (v && typeof v === "object" && !Array.isArray(v) && (v._ref !== undefined || v._type !== undefined)) {
      const nestedSlim = {};
      for (const f of SLIM_FIELDS) {
        if (v[f] !== undefined) nestedSlim[f] = v[f];
      }
      slim[k] = nestedSlim;
    }
  }
  return slim;
}

function trimRecord(record) {
  const result = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
      result[key] = value;
    } else if (value._tagsNameArray !== undefined) {
      // Tags collection — preserve the name array used by compare.js
      result[key] = { Count: value.Count, _tagsNameArray: value._tagsNameArray };
    } else if (value._ref !== undefined || value._type !== undefined) {
      result[key] = slimRallyObject(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// --- Main --------------------------------------------------------------------

async function main() {
  const orderString = buildOrderString(CONFIG.order);
  const fetchFields = CONFIG.fetch.join(",");
  const { mode, ref, refs, scopeDown } = CONFIG.project;

  const orderParam = orderString ? { order: orderString } : {};

  const recordTypes = Array.isArray(CONFIG.recordType)
    ? CONFIG.recordType
    : [CONFIG.recordType];

  const allRecords = [];
  const seen = new Set();

  async function runQuery(params) {
    for (const recordType of recordTypes) {
      const records = await fetchAll(recordType, params);
      for (const record of records) {
        if (!seen.has(record._ref)) {
          seen.add(record._ref);
          allRecords.push(record);
        }
      }
    }
  }

  if (mode === "workspace") {
    const queryString = buildQueryString(CONFIG.filters);
    const queryParam = queryString ? { query: queryString } : {};
    await runQuery({ fetch: fetchFields, ...queryParam, ...orderParam });

  } else if (mode === "single") {
    if (scopeDown) {
      const projectIds = await fetchDescendantProjectIds(ref);
      const scopedQuery = buildQueryString([...CONFIG.filters, buildProjectFilterGroup(projectIds)]);
      const queryParam = scopedQuery ? { query: scopedQuery } : {};
      await runQuery({ fetch: fetchFields, ...queryParam, ...orderParam });
    } else {
      const queryString = buildQueryString(CONFIG.filters);
      const queryParam = queryString ? { query: queryString } : {};
      await runQuery({
        fetch: fetchFields,
        project: `${CONFIG.rally.baseUrl}${ref}`,
        projectScopeDown: "false",
        ...queryParam,
        ...orderParam,
      });
    }

  } else if (mode === "multiple") {
    if (scopeDown) {
      const allProjectIds = [];
      const seenIds = new Set();
      for (const projectRef of refs) {
        for (const id of await fetchDescendantProjectIds(projectRef)) {
          if (!seenIds.has(id)) { seenIds.add(id); allProjectIds.push(id); }
        }
      }
      const scopedQuery = buildQueryString([...CONFIG.filters, buildProjectFilterGroup(allProjectIds)]);
      const queryParam = scopedQuery ? { query: scopedQuery } : {};
      await runQuery({ fetch: fetchFields, ...queryParam, ...orderParam });
    } else {
      const queryString = buildQueryString(CONFIG.filters);
      const queryParam = queryString ? { query: queryString } : {};
      for (const projectRef of refs) {
        for (const recordType of recordTypes) {
          const records = await fetchAll(recordType, {
            fetch: fetchFields,
            project: `${CONFIG.rally.baseUrl}${projectRef}`,
            projectScopeDown: "false",
            ...queryParam,
            ...orderParam,
          });
          for (const record of records) {
            if (!seen.has(record.ObjectID)) {
              seen.add(record.ObjectID);
              allRecords.push(record);
            }
          }
        }
      }
    }

  } else {
    throw new Error(`Unknown project.mode: "${mode}". Use "single", "multiple", or "workspace".`);
  }

  console.log(`Fetched ${allRecords.length} Rally records`);
  output.set("rallyRecord", allRecords.map((r, index) => JSON.stringify({ ...trimRecord(r), _rank: index + 1 })));
}

await main();
