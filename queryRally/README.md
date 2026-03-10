# queryRally

Paste `queryRally/script.js` into the Airtable Automation "Run a script" action that precedes the Repeating Group. It fetches records from Rally and passes them to the group via `output.set()`.

**Automation order:**
1. **Run a script** — this script (queryRally) fetches Rally records
2. **Repeating Group** — iterates over the fetched records, one per run
3. **Run a script** (inside the group) — compare.js syncs each record to Airtable

## Setup

Edit only the `CONFIG` object at the top of the script.

```
CONFIG.rally.apiKey        Your Rally API key (ZSESSIONID)
CONFIG.recordType          The Rally artifact type to query
CONFIG.project             How to scope the query (see Project Modes)
CONFIG.filters             Field-level filters (see Filters)
CONFIG.fetch               Fields to retrieve from Rally
CONFIG.pageSize            Records per page (max 2000; keep at 2000 — Airtable caps scripts at 50 fetch calls, so 50 × 2000 = 100k records max)
```

## Record Types

`recordType` accepts a single string or an array of strings. When an array is given, each type is queried with the same project scope, filters, and order. Results are merged and deduplicated by `ObjectID`.

```js
// Single type
recordType: "HierarchicalRequirement",

// Multiple types — same project scope, filters, and order apply to each
recordType: ["PortfolioItem/Feature", "HierarchicalRequirement"],
```

| Type | `recordType` value |
|---|---|
| User Story | `"HierarchicalRequirement"` |
| Feature | `"PortfolioItem/Feature"` |
| Defect | `"Defect"` |
| Task | `"Task"` |
| Test Case | `"TestCase"` |

When querying multiple types, include fields from all types in `fetch`. Fields that don't exist on a given type are simply omitted by Rally — they won't cause errors.

### Different project scopes per type

If each type needs a different project scope (e.g. Features from one project, User Stories from another), use separate queryRally scripts chained in the automation:

```
[Run script: queryRally]  ← Features, project A
  → [Repeating Group]
      → [Run script: compare]

[Run script: queryRally]  ← User Stories, projects B + C
  → [Repeating Group]
      → [Run script: compare]
```

Each queryRally has its own CONFIG. The same compare script handles both record types — see the compare README for how to write type-agnostic field mappings.

## Project Modes

### Single project

```js
project: {
  mode: "single",
  ref: "/project/12345678910",
  scopeDown: false,
},
```

### Single project + all child projects

```js
project: {
  mode: "single",
  ref: "/project/12345678910",
  scopeDown: true,
},
```

When `scopeDown: true`, the script first queries Rally's project collection to discover all descendant project IDs (1–2 extra API calls), then runs the main record query at workspace scope filtered by `Project.ObjectID`. This approach works correctly for all Rally artifact types, including Portfolio Items.

### Multiple specific projects

Queries each project sequentially and deduplicates results by `ObjectID`.

```js
project: {
  mode: "multiple",
  refs: ["/project/11111111111", "/project/22222222222"],
  scopeDown: false,
},
```

`scopeDown: true` on `mode: "multiple"` discovers all descendants of each ref, merges and deduplicates the project ID list, then runs a single workspace-scope query.

### Entire workspace (no project filter)

```js
project: {
  mode: "workspace",
},
```

## Filters

Each entry in `filters` is a **plain condition** or a **group**. All entries default to AND-chaining with the previous; set `logicalOp: "OR"` to OR-chain instead. `value` can be a static string or a function.

### Plain conditions

```js
filters: [
  { field: "Owner.Name",          operator: "=",        value: "Jane Smith" },
  { field: "ScheduleState",       operator: "!=",       value: "Completed"  },
  { field: "Iteration.StartDate", operator: ">=",       value: "2025-01-01" },
  { field: "Release.Name",        operator: "contains", value: "Q1"         },
  { field: "c_CustomField",       operator: "=",        value: "someValue"  },
  { field: "Release",             operator: "=",        value: null         },  // null check
],
```

To filter for records where a field is empty/unset, use `value: null` (JavaScript `null`). This produces `Release = ""` in the query — an empty quoted string, which is how Rally WSAPI checks for null/empty object references.

| Operator | Meaning |
|---|---|
| `=` | Equals |
| `!=` | Not equals |
| `<` | Less than |
| `<=` | Less than or equal |
| `>` | Greater than |
| `>=` | Greater than or equal |
| `contains` | String contains |
| `!contains` | String does not contain |

Custom fields use a `c_` prefix: e.g. `"c_TeamName"`.

### Groups

A group entry wraps multiple conditions with their own internal logic (`groupLogic`), then connects the whole group to the outer result via `logicalOp`.

```js
filters: [
  // Must be owned by Jane
  { field: "Owner.Name", operator: "=", value: "Jane Smith" },

  // AND must be in one of these states (OR within the group)
  {
    groupLogic: "OR",
    group: [
      { field: "ScheduleState", operator: "=", value: "Defined"     },
      { field: "ScheduleState", operator: "=", value: "In-Progress" },
    ],
  },

  // OR belongs to a release starting in the last 6 months with a known name
  {
    logicalOp: "OR",
    groupLogic: "AND",
    group: [
      { field: "Release.ReleaseStartDate", operator: ">=", value: () => monthsAgo(6) },
      { field: "Release.Name",             operator: "!=", value: "Unscheduled"      },
    ],
  },
],
// Produces:
// (((Owner.Name = "Jane Smith") AND
//   ((ScheduleState = "Defined") OR (ScheduleState = "In-Progress")))
//  OR ((Release.ReleaseStartDate >= "...") AND (Release.Name != "Unscheduled")))
```

| Property | On condition | On group |
|---|---|---|
| `logicalOp` | Connects this condition to the previous entry (`"AND"` default) | Connects this group to the previous entry (`"AND"` default) |
| `groupLogic` | — | Combines conditions inside the group (`"AND"` default) |

Groups cannot be nested.

### Date filters

For dates relative to now, use the built-in helpers as function values:

```js
filters: [
  // Features with a release starting within the last 6 months
  { field: "Release.StartDate", operator: ">=", value: () => monthsAgo(6) },

  // Records updated in the last 30 days
  { field: "LastUpdateDate", operator: ">=", value: () => daysAgo(30) },

  // Iterations starting within the last 2 weeks
  { field: "Iteration.StartDate", operator: ">=", value: () => weeksAgo(2) },
],
```

| Helper | Example | Returns |
|---|---|---|
| `daysAgo(n)` | `() => daysAgo(30)` | `"yyyy-mm-dd"` — n days before today |
| `weeksAgo(n)` | `() => weeksAgo(2)` | `"yyyy-mm-dd"` — n weeks before today |
| `monthsAgo(n)` | `() => monthsAgo(6)` | `"yyyy-mm-dd"` — n months before today (calendar-aware) |

All helpers return `yyyy-mm-dd` with leading zeros, which is the format Rally WSAPI requires for date comparisons.

You can also write any expression inline, as long as it returns `yyyy-mm-dd`:

```js
// Exactly 90 days ago
value: () => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 90);
  return d.toISOString().slice(0, 10);
},
```

## Order

Control the sort order of returned records. Direction defaults to `"ASC"` if omitted.

```js
order: [
  { field: "Release.ReleaseStartDate", direction: "ASC"  },
  { field: "Rank",                     direction: "ASC"  },
  { field: "LastUpdateDate",           direction: "DESC" },
],
```

Multiple entries are applied left-to-right (primary sort first). Rally applies ordering server-side per page, so paginated results remain consistently sorted.

> **Note for `multiple` mode:** Each project is queried separately and results are merged. Ordering applies within each project's result set, but the final merged array is not globally re-sorted.

## fetch

Only request fields that compare.js actually reads. Requesting extra fields slows the query and increases output size.

> **Note:** Nested Rally objects in the `fetch` list (e.g. `Owner`, `Project`, `Iteration`) are trimmed to identity fields (`ObjectID`, `Name`, `DisplayName`, `_refObjectName`, `_ref`, etc.) to keep the output payload small. Sub-objects one level deep (e.g. `Project.Parent`) are also preserved as slimmed objects, so extractor functions in compare.js can read `r.Project?.Parent?._refObjectName` without a separate Rally API call. If you need fields beyond what the slim set provides, use `fetchRallyDetails` in a `createIfMissing` config — see the compare README.

```js
fetch: [
  "FormattedID",
  "Name",
  "ScheduleState",
  "Owner",       // returns { DisplayName, EmailAddress, ... }
  "Project",     // returns { Name, ... }
  "Tags",        // returns { _tagsNameArray: [{ Name }] }
  "LastUpdateDate",
  "Iteration",   // returns { Name, StartDate, EndDate, ... }
  "Release",     // returns { Name, ReleaseStartDate, ReleaseDate, ... }
],
```

## Output & Repeating Group setup

The script outputs:

```js
output.set("rallyRecord", allRecords); // array of Rally record objects
```

In your Airtable automation, configure the **Repeating Group** to iterate over the `rallyRecord` output from this script. The compare script reads each item via `input.config().rallyRecord`.
