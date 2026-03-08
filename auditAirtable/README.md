# auditAirtable

Paste `auditAirtable/script.js` into a standalone Airtable Automation "Run a script" action. It compares all Airtable records that originated from Rally against the current Rally record set, and marks any record whose Rally counterpart no longer exists in scope.

Unlike `queryRally` + `compare`, this script does not use a Repeating Group. It runs as a single step.

## Setup

Edit only the `CONFIG` object at the top of the script.

```
CONFIG.rally.apiKey           Your Rally API key (ZSESSIONID)
CONFIG.recordType             The Rally artifact type(s) to audit — must match queryRally
CONFIG.project                Project scope — must match the queryRally scope used to populate this table
CONFIG.filters                Additional Rally filters to narrow scope — must match queryRally
CONFIG.airtable.tableId       The Airtable table containing Rally-sourced records
CONFIG.airtable.rallyIdFieldId  Field holding the Rally FormattedID (e.g. "F123456", "US789")
CONFIG.airtable.statusFieldId   Single select field to stamp on stale records
CONFIG.airtable.statusValue     The option to write when a record is no longer found in Rally
CONFIG.airtable.sourceFieldId   (Optional) Single select field that identifies the record's source
CONFIG.airtable.sourceFilterValue  The source value that means "this came from Rally"
CONFIG.airtable.filterByFormula (Optional) Additional Airtable formula to further filter audited records
CONFIG.dryRun                 Set to true to preview results without writing to Airtable
```

## How it works

1. **Fetch Airtable records** — queries the target table for records where the Rally ID field is non-empty. If `sourceFieldId` is configured, only records matching `sourceFilterValue` are included (see [Source field filter](#source-field-filter) below).
2. **Fetch Rally records** — queries Rally using the same project scope and filters as `queryRally/script.js`, retrieving only `FormattedID`.
3. **Diff** — any Airtable record whose Rally ID is not found in the Rally results is considered stale.
4. **Update** — stale records have `statusFieldId` set to `statusValue`. Updates are batched in groups of 50.

If the Rally query fails, the script throws before touching Airtable — no records are partially updated.

## Keeping scope in sync with queryRally

`CONFIG.recordType`, `CONFIG.project`, and `CONFIG.filters` should match the values used in the `queryRally` script that originally populated your table. If they diverge, the audit may incorrectly flag records that exist in Rally but outside the configured scope.

## Source field filter

When multiple record sources share the same ID format (e.g. Features from Rally, Management, and Strategy all use `"F######"`), the source field filter prevents non-Rally records from being included in the audit.

```js
airtable: {
  sourceFieldId: "fldXXXXXXXXXXXXXX", // single select field identifying the record's source
  sourceFilterValue: "Rally",          // only audit records with this source value
},
```

The script builds a server-side `filterByFormula` automatically:

```
AND({fldRallyId} != "", {fldSource} = "Rally")
```

Set `sourceFieldId: null` to skip this filter and audit all records that have a non-empty Rally ID field.

## filterByFormula

Use `CONFIG.airtable.filterByFormula` to add any additional Airtable formula clause. It is AND'd together with the Rally ID check and source field filter automatically.

```js
// Only audit records not already marked Archived
filterByFormula: 'NOT({Status} = "Archived")',
```

When all three filters are active, the combined formula looks like:

```
AND({fldRallyId} != "", {fldSource} = "Rally", NOT({Status} = "Archived"))
```

## Dry run

Set `dryRun: true` to preview the audit without making any changes. The script will still query both Airtable and Rally, log which records would be updated, and print a summary — but it will not call `updateRecordsAsync`.

## statusValue

The `statusValue` must already exist as an option in the target single select field before running the script. Airtable will throw an error if the option does not exist.

## Record Types

`recordType` accepts a single string or an array of strings. When an array is given, all types are queried with the same project scope and filters.

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

### Multiple specific projects

```js
project: {
  mode: "multiple",
  refs: ["/project/11111111111", "/project/22222222222"],
  scopeDown: false,
},
```

### Entire workspace

```js
project: {
  mode: "workspace",
},
```

See `queryRally/README.md` for full details on project scoping behavior.

## Filters

`CONFIG.filters` uses the same syntax as `queryRally/script.js`. See `queryRally/README.md` for the full filter reference including plain conditions, groups, operators, and date helpers.

## Console output

The script logs progress at each step and prints a summary when complete:

```
=== auditAirtable starting ===
dryRun: false
Step 1: Fetching Airtable records with Rally IDs...
Found 142 Airtable records to audit
Step 2: Fetching all Rally records in scope...
Rally request: https://rally1.rallydev.com/...
Found 139 Rally records in scope
Step 3: Identifying stale Airtable records...
Found 3 stale Airtable records (Rally ID not found in scope)
Stale Rally IDs: F100023, F100031, F100089
Step 4: Setting "Inactive" on 3 stale records...
Updated batch of 3 Airtable records (3/3 total)
=== auditAirtable complete ===
  Airtable records audited:  142
  Rally records in scope:    139
  Stale records found:       3
  Records updated:           3 (dryRun=false)
```
