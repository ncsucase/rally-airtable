# auditRecord

Paste `auditRecord/script.js` into the "Run a script" action inside a Repeating Group. For each Airtable record passed in, the script queries Rally to determine the record's current status and stamps the result back to Airtable.

**Automation order:**
1. **Trigger** — scheduled or manual
2. **Find Records** (Airtable native) — select which Airtable records to audit
3. **Repeating Group** — iterates over the found records, one per run
4. **Run a script** (inside the group) — this script checks each record against Rally

## Setup

### 1. Configure input variables

In the Airtable script editor, add two input variables before pasting the script:

| Variable name | Map to |
|---|---|
| `rallyId` | The field holding the Rally FormattedID (e.g. `"F12345"`, `"US789"`) |
| `recordId` | The record ID |

### 2. Edit the `CONFIG` object

```
CONFIG.rally.apiKey           Your Rally API key (ZSESSIONID)
CONFIG.recordType             The Rally artifact type — must match the type used to populate Airtable
CONFIG.airtable.tableId       The Airtable table containing Rally-sourced records
CONFIG.airtable.statusFieldId Single select field to stamp with the audit result
CONFIG.dryRun                 Set to true to preview results without writing to Airtable
```

Three-state mode requires additional CONFIG (see [Binary vs three-state mode](#binary-vs-three-state-mode)):

```
CONFIG.project    Project scope for the "in-scope" check — must match queryRally settings
CONFIG.filters    Filters for the "in-scope" check — must match queryRally settings
```

## Binary vs three-state mode

The script operates in one of two modes, selected by the status keys you define in `CONFIG.airtable`.

### Binary mode

Set `statusValue` to a single status option. Any record not found anywhere in Rally is marked with this value. Records that still exist in Rally are left unchanged (or stamped with `statusCurrent` if set).

```js
airtable: {
  statusFieldId: "fldXXXXXXXXXXXXXX",
  statusValue: "Inactive",  // record not found anywhere in Rally
},
```

One Rally API call per record. `CONFIG.project` and `CONFIG.filters` are not used.

### Three-state mode

Set distinct values for `statusGone` and `statusOutOfScope`. The script makes up to two Rally calls per record to distinguish the three states:

| State | Condition | CONFIG key |
|---|---|---|
| Current | Found in scoped query (project + filters) | `statusCurrent` |
| Out of scope | Exists in Rally but not in scoped query | `statusOutOfScope` |
| Gone | Not found anywhere in Rally | `statusGone` |

```js
airtable: {
  statusFieldId:    "fldXXXXXXXXXXXXXX",
  statusGone:       "Removed from Rally", // deleted from Rally entirely
  statusOutOfScope: "Out of Scope",       // exists in Rally but no longer matches criteria
  statusCurrent:    null,                 // set to e.g. "Active" to stamp current records; null = skip
},
```

Set any value to `null` to skip updating records in that bucket. All values used must already exist as options in the target field before running the script.

`CONFIG.project` and `CONFIG.filters` must match the values used in `queryRally/script.js` for this table.

## Record Types

`recordType` accepts a single string or an array of strings.

```js
// Single type
recordType: "PortfolioItem/Feature",

// Multiple types
recordType: ["PortfolioItem/Feature", "HierarchicalRequirement"],
```

| Type | `recordType` value |
|---|---|
| User Story | `"HierarchicalRequirement"` |
| Feature | `"PortfolioItem/Feature"` |
| Defect | `"Defect"` |
| Task | `"Task"` |
| Test Case | `"TestCase"` |

When `recordType` is an array, each type is checked in order. The record is considered found as soon as any type returns a match.

## Project Modes

Used only in three-state mode. Must match `queryRally/script.js` CONFIG.

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

Rally's native `projectScopeDown` parameter is used — no additional API calls needed.

### Multiple specific projects

```js
project: {
  mode: "multiple",
  refs: ["/project/11111111111", "/project/22222222222"],
  scopeDown: false,
},
```

Project IDs are extracted directly from the `refs` strings — no extra API calls. With `scopeDown: true`, one API call is made per project ref using Rally's `projectScopeDown` parameter.

### Entire workspace

```js
project: {
  mode: "workspace",
},
```

## Filters

Used only in three-state mode for the "in-scope" check. Must match `queryRally/script.js`. See `queryRally/README.md` for the full filter reference including plain conditions, groups, operators, and date helpers.

```js
filters: [
  { field: "ScheduleState", operator: "!=", value: "Completed" },
  { field: "Release.Name",  operator: "contains", value: "Q1" },
],
```

## Dry run

Set `dryRun: true` to preview the audit without writing to Airtable. The script still queries Rally and logs the classification for each record.

## Console output

Each record produces a single log line:

```
Auditing F12345 (three-state mode)...
Rally request: https://rally1.rallydev.com/...
F12345 → current → no update (statusValue is null)

Auditing F99999 (three-state mode)...
Rally request: https://rally1.rallydev.com/...
Rally request: https://rally1.rallydev.com/...
F99999 → outOfScope → set "Out of Scope"

Auditing F00001 (three-state mode)...
Rally request: https://rally1.rallydev.com/...
Rally request: https://rally1.rallydev.com/...
F00001 → gone → set "Removed from Rally"
```
