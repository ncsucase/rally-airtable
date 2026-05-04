# auditRecord

Paste `auditRecord/script.js` into the "Run a script" action inside a Repeating Group. For each Airtable record passed in, the script queries Rally to determine the record's current status, stamps the result back to Airtable, and — optionally — writes Rally field values to additional Airtable fields in the same pass.

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

Field enrichment is optional (see [Field enrichment](#field-enrichment)):

```
CONFIG.fieldMappings    Rally fields to fetch and write to Airtable alongside the status stamp
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

## Field enrichment

`fieldMappings` is an optional array of Rally→Airtable field mappings. When present, the fields listed are fetched from Rally during the same API call used for the existence check — no additional Rally calls are made. Enrichment fields are written for **current** and **outOfScope** records (any time a Rally record is found); no enrichment is written for **gone** records.

```js
fieldMappings: [
  { rallyField: "Name",              airtableFieldId: "fldXXX", airtableFieldType: "singleLineText" },
  { rallyField: "Owner.DisplayName", airtableFieldId: "fldXXX", airtableFieldType: "singleLineText" },
  { rallyField: "Description",       airtableFieldId: "fldXXX", airtableFieldType: "richText" },
],
```

Omit `fieldMappings` entirely (or leave it as an empty array) to keep the script audit-only.

### Mapping keys

| Key | Required | Description |
|---|---|---|
| `rallyField` | yes | Dot-path string (`"Owner.DisplayName"`) or extractor function (`r => r.State?.Name`) |
| `rallyFetch` | only if `rallyField` is a function | Top-level Rally field name to include in the `fetch=` request param |
| `airtableFieldId` | yes | Target Airtable field ID |
| `airtableFieldType` | yes | Airtable field type (see supported types below) |
| `transform` | no | Function applied to the raw Rally value before writing, e.g. `v => v?.toUpperCase()` |
| `nullHandling` | no | What to do when the Rally value is null — see [Null handling](#null-handling) |
| `nullValue` | no | Fallback written when `nullHandling` is `"mapToValue"` |

### Supported field types

| `airtableFieldType` | Notes |
|---|---|
| `singleLineText` | |
| `multilineText` | |
| `url` | |
| `email` | |
| `phoneNumber` | |
| `number` | |
| `currency` | |
| `percent` | |
| `rating` | |
| `checkbox` | |
| `date` | Written as `YYYY-MM-DD` |
| `dateTime` | Written as ISO 8601 |
| `singleSelect` | Written as a plain string matching an existing option name |
| `multipleSelect` | Written as an array of strings |
| `richText` | Rally HTML is converted to Markdown — see [Rich text](#rich-text) |
| `linkedRecord` | Resolved via lookup in a linked Airtable table — see [Linked records](#linked-records) |

### Null handling

Controls what happens when the Rally value resolves to `null`, `undefined`, or an empty array.

| `nullHandling` value | Behavior |
|---|---|
| `"writeNull"` (default) | Clears the Airtable field |
| `"ignore"` | Skips the field entirely — existing Airtable value is preserved |
| `"mapToValue"` | Writes `nullValue` (or `null` if `nullValue` is not set) |

### Rich text

Rally stores rich text fields (e.g. `Description`, `Notes`) as HTML. Setting `airtableFieldType: "richText"` automatically converts the HTML to Markdown before writing. Supported conversions:

- Bold, italic, inline code
- Headings (h1–h6)
- Ordered and unordered lists
- Links
- Code blocks (`<pre>`)
- Tables (converted to Markdown pipe tables)
- HTML entities (`&amp;`, `&lt;`, `&nbsp;`, etc.)
- Images → `[Image: filename]` placeholder (inline images are not transferred)

### Linked records

Set `airtableFieldType: "linkedRecord"` to resolve a Rally value to a record in another Airtable table. Instead of writing the raw value, the script looks up a matching record in the linked table and writes its record ID.

```js
{
  rallyField: "Owner.DisplayName",
  airtableFieldId: "fldXXX",
  airtableFieldType: "linkedRecord",
  linkedRecord: {
    linkedTableId: "tblXXX",
    lookup: {
      fieldId: "fldEMAILXXX",                    // field ID in the linked table to match against
      rallyValue: r => r.Owner?.EmailAddress,     // how to extract the match key from the Rally record
    },
    createIfMissing: {                            // optional — omit to leave the field blank when no match
      fields: {
        "fldNAMEXXX":  r => r.Owner?.DisplayName,
        "fldEMAILXXX": r => r.Owner?.EmailAddress,
      },
    },
  },
  nullHandling: "ignore",
},
```

#### `linkedRecord` keys

| Key | Required | Description |
|---|---|---|
| `linkedTableId` | yes | Airtable table ID to search |
| `lookup.fieldId` | yes | Field ID in the linked table to match against |
| `lookup.rallyValue` | yes | Function `(r) => value` that extracts the match key from the Rally record |
| `createIfMissing` | no | If present, a new record is created in the linked table when no match is found |
| `createIfMissing.fields` | yes (if `createIfMissing` is set) | Object mapping field IDs to extractor functions or static values; all values are written as strings |

When `createIfMissing` is omitted and no match is found, `nullHandling` controls the outcome — `"ignore"` leaves the Airtable field unchanged, `"writeNull"` clears it.

This field type is intentionally simpler than the equivalent in `compare/script.js`: no `direction` or `matchMode` (audit is always Rally→Airtable only), no cross-record lookup cache (the script runs one record at a time in a Repeating Group).

### Function extractors

Use a function when the value you need requires logic beyond dot-path traversal. Provide `rallyFetch` to name the top-level Rally field that should be included in the API request.

```js
{ rallyField: r => r.State?.Name,   rallyFetch: "State",   airtableFieldId: "fldXXX", airtableFieldType: "singleSelect" },
{ rallyField: r => r.Tags?.map(t => t.Name), rallyFetch: "Tags", airtableFieldId: "fldXXX", airtableFieldType: "multipleSelect" },
```

## Record types

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
| Epic / Initiative | `"PortfolioItem/Initiative"` |
| Defect | `"Defect"` |
| Task | `"Task"` |
| Test Case | `"TestCase"` |

When `recordType` is an array, each type is checked in order. The record is considered found as soon as any type returns a match.

## Project modes

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

Set `dryRun: true` to preview the audit without writing to Airtable. The script still queries Rally and logs what would be written for each record.

## Console output

```
Auditing F12345 (three-state mode)...
Rally request: https://rally1.rallydev.com/...
F12345 → current → no update

Auditing F99999 (three-state mode)...
Rally request: https://rally1.rallydev.com/...
Rally request: https://rally1.rallydev.com/...
F99999 → outOfScope → updated 3 field(s)

Auditing F00001 (three-state mode)...
Rally request: https://rally1.rallydev.com/...
Rally request: https://rally1.rallydev.com/...
F00001 → gone → updated 1 field(s)
```

With `dryRun: true`, writes are replaced with a log showing the full Airtable update object that would have been sent.
