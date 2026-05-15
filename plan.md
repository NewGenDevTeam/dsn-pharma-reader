# Integration Plan — AutoCount Sync

**Version:** 1.0  
**Source:** AutoCount (`dsnpharma`) on local Windows machine  
**Destination:** Remote server → PostgreSQL  
**Client app:** Electron desktop app (`autocount-reader`)  
**Company:** DSN PHARMA SDN. BHD. (1364732-V)

---

## 1. How the Sync Works

```
[AutoCount SQL Server]  →  [Electron App]  →  [REST API]  →  [PostgreSQL]
   dsnpharma                every 5 min        your server
```

1. The Electron app logs in to the REST API and gets a JWT token.
2. Every 5 minutes it reads all 338 tables from local SQL Server.
3. For each table it sends a `POST` with the changed rows as JSON.
4. The server receives the rows and **upserts** them into PostgreSQL (insert if new, update if exists).

All 338 tables are synced. The app auto-detects which tables have changed since the last run.

---

## 2. API Endpoints Required

### 2.1 `POST /api/auth/login`

The app calls this on first login and when the token expires (auto-refresh).

**Request:**
```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "string",
  "password": "string"
}
```

**Response `200 OK`:**
```json
{
  "token": "eyJhbGci...",
  "expiresIn": 86400
}
```
`expiresIn` is in **seconds** (e.g. `86400` = 24 hours).

**Response `401 Unauthorized`:**
```json
{ "error": "Invalid credentials" }
```

---

### 2.2 `POST /api/sync/:tableName`

Called once per table per sync cycle. The `:tableName` matches the AutoCount table name exactly (e.g. `IV`, `IVDTL`, `Debtor`, `Item`).

**Request:**
```http
POST /api/sync/IV
Content-Type: application/json
Authorization: Bearer eyJhbGci...

{
  "rows": [
    {
      "DocKey": 1234567,
      "DocNo": "IV-2605-0001",
      "DocDate": "2026-05-14T00:00:00.000Z",
      "DebtorCode": "300-0001",
      "DebtorName": "KLINIK ZAHRA",
      "NetTotal": 500.00,
      "Cancelled": "F",
      ...
    },
    { ... }
  ]
}
```

**Notes on data values:**
- `datetime` columns arrive as ISO 8601 strings: `"2026-05-14T00:00:00.000Z"`
- `char(1)` boolean columns (`Cancelled`, `IsActive`, etc.) arrive as `"T"` or `"F"` — store as-is or convert to PostgreSQL `BOOLEAN`
- `nvarchar(-1)` / large text columns arrive as plain strings
- `varbinary` (image/binary) columns arrive as **Base64-encoded strings**
- `null` values arrive as JSON `null`
- `uniqueidentifier` (GUID) arrives as a lowercase UUID string: `"3db85000-d941-4077-bf70-e5e0238a4ed0"`

**Response `200 OK`:**
```json
{ "upserted": 42 }
```
`upserted` = number of rows inserted or updated.

**Response `401 Unauthorized`:**
The app will automatically re-login and retry the request once. Return this if the token is invalid or expired.

**Response `4xx / 5xx`:**
The app logs the error for that table and continues to the next table. It does NOT retry failed tables in the same cycle.

---

### 2.3 Token Refresh Behaviour

The app stores the token locally. When any `/api/sync/:tableName` call returns `401`, the app:
1. Re-calls `POST /api/auth/login` with stored credentials
2. Saves the new token
3. Retries the failed table request once

The server does not need to implement refresh tokens — a standard short-lived JWT is fine.

---

## 3. PostgreSQL Schema

### 3.1 Type Mapping Reference

Use this to convert any SQL Server column to PostgreSQL:

| SQL Server type | PostgreSQL type | Notes |
|---|---|---|
| `bigint` | `BIGINT` | Primary/foreign keys |
| `int` | `INTEGER` | |
| `smallint` | `SMALLINT` | |
| `tinyint` | `SMALLINT` | |
| `decimal` / `numeric` | `NUMERIC` | Keep full precision |
| `nvarchar(n)` | `VARCHAR(n)` | Use exact length |
| `nvarchar(-1)` | `TEXT` | Unbounded |
| `varchar(n)` | `VARCHAR(n)` | |
| `char(1)` | `CHAR(1)` | AutoCount uses `'T'`/`'F'` as booleans |
| `datetime` | `TIMESTAMPTZ` | App sends ISO 8601 strings |
| `uniqueidentifier` | `UUID` | App sends lowercase UUID strings |
| `varbinary(-1)` | `TEXT` | App sends Base64-encoded string |
| `bit` | `BOOLEAN` | |

### 3.2 Upsert Strategy

Every table needs a primary key for upsert. Use this priority:
1. If table has `DocKey` → primary key is `DocKey`
2. If table has `DtlKey` → primary key is `DtlKey`
3. If table has `AutoKey` → primary key is `AutoKey`
4. Otherwise → use all columns as a composite key or `ON CONFLICT DO NOTHING`

PostgreSQL upsert pattern:
```sql
INSERT INTO "IV" ("DocKey", "DocNo", ...)
VALUES ($1, $2, ...)
ON CONFLICT ("DocKey")
DO UPDATE SET
  "DocNo"    = EXCLUDED."DocNo",
  "DocDate"  = EXCLUDED."DocDate",
  ...;
```

> **Important:** Column and table names are case-sensitive in PostgreSQL when quoted. Use double-quotes around all identifiers that match the AutoCount names (mixed case).

---

### 3.3 Core Table Schemas

#### `IV` — Sales Invoices (5,025 rows)
Primary key: `DocKey`

```sql
CREATE TABLE "IV" (
  "DocKey"                       BIGINT        PRIMARY KEY,
  "DocNo"                        VARCHAR(20)   NOT NULL,
  "DocDate"                      TIMESTAMPTZ   NOT NULL,
  "DebtorCode"                   VARCHAR(12)   NOT NULL,
  "DebtorName"                   VARCHAR(100),
  "Ref"                          VARCHAR(40),
  "Description"                  VARCHAR(80),
  "DisplayTerm"                  VARCHAR(30)   NOT NULL,
  "SalesAgent"                   VARCHAR(12),
  "InvAddr1"                     VARCHAR(40),
  "InvAddr2"                     VARCHAR(40),
  "InvAddr3"                     VARCHAR(40),
  "InvAddr4"                     VARCHAR(40),
  "Phone1"                       VARCHAR(25),
  "Fax1"                         VARCHAR(25),
  "Attention"                    VARCHAR(40),
  "BranchCode"                   VARCHAR(20),
  "DeliverAddr1"                 VARCHAR(40),
  "DeliverAddr2"                 VARCHAR(40),
  "DeliverAddr3"                 VARCHAR(40),
  "DeliverAddr4"                 VARCHAR(40),
  "DeliverPhone1"                VARCHAR(25),
  "DeliverFax1"                  VARCHAR(25),
  "DeliverContact"               VARCHAR(40),
  "SalesExemptionNo"             VARCHAR(60),
  "SalesExemptionExpiryDate"     TIMESTAMPTZ,
  "Total"                        NUMERIC,
  "Footer1Param"                 NUMERIC,
  "Footer1Amt"                   NUMERIC,
  "Footer1LocalAmt"              NUMERIC,
  "Footer1TaxType"               VARCHAR(14),
  "Footer2Param"                 NUMERIC,
  "Footer2Amt"                   NUMERIC,
  "Footer2LocalAmt"              NUMERIC,
  "Footer2TaxType"               VARCHAR(14),
  "Footer3Param"                 NUMERIC,
  "Footer3Amt"                   NUMERIC,
  "Footer3LocalAmt"              NUMERIC,
  "Footer3TaxType"               VARCHAR(14),
  "CurrencyCode"                 VARCHAR(5)    NOT NULL,
  "CurrencyRate"                 NUMERIC       NOT NULL,
  "NetTotal"                     NUMERIC,
  "LocalNetTotal"                NUMERIC,
  "AnalysisNetTotal"             NUMERIC,
  "LocalAnalysisNetTotal"        NUMERIC,
  "LocalTotalCost"               NUMERIC,
  "Tax"                          NUMERIC,
  "LocalTax"                     NUMERIC,
  "TotalBonusPoint"              NUMERIC,
  "PostToStock"                  CHAR(1)       NOT NULL,
  "PostToGL"                     CHAR(1)       NOT NULL,
  "ReferDocKey"                  BIGINT,
  "ReferPaymentDocKey"           BIGINT,
  "Transferable"                 CHAR(1)       NOT NULL,
  "ToDocType"                    VARCHAR(2),
  "ToDocKey"                     BIGINT,
  "Note"                         TEXT,
  "Remark1"                      VARCHAR(40),
  "Remark2"                      VARCHAR(40),
  "Remark3"                      VARCHAR(40),
  "Remark4"                      VARCHAR(40),
  "PrintCount"                   SMALLINT      NOT NULL,
  "Cancelled"                    CHAR(1)       NOT NULL,
  "LastModified"                 TIMESTAMPTZ   NOT NULL,
  "LastModifiedUserID"           VARCHAR(10)   NOT NULL,
  "CreatedTimeStamp"             TIMESTAMPTZ   NOT NULL,
  "CreatedUserID"                VARCHAR(10)   NOT NULL,
  "ExternalLink"                 TEXT,
  "RefDocNo"                     VARCHAR(20),
  "CanSync"                      CHAR(1)       NOT NULL,
  "LastUpdate"                   INTEGER       NOT NULL,
  "MemberNo"                     VARCHAR(20),
  "ToDtlKey"                     BIGINT,
  "FullTransferOption"           CHAR(1),
  "ShipVia"                      VARCHAR(20),
  "ShipInfo"                     VARCHAR(40),
  "ReallocatePurchaseByProject"  CHAR(1)       NOT NULL,
  "ReallocatePurchaseByProjectJEDocKey" BIGINT,
  "RefNo2"                       VARCHAR(20),
  "SalesLocation"                VARCHAR(8),
  "Footer1Tax"                   NUMERIC,
  "Footer1LocalTax"              NUMERIC,
  "Footer2Tax"                   NUMERIC,
  "Footer2LocalTax"              NUMERIC,
  "Footer3Tax"                   NUMERIC,
  "Footer3LocalTax"              NUMERIC,
  "ExTax"                        NUMERIC,
  "LocalExTax"                   NUMERIC,
  "YourPONo"                     VARCHAR(25),
  "YourPODate"                   TIMESTAMPTZ,
  "Guid"                         UUID          NOT NULL,
  "ReallocatePurchaseByProjectNo" VARCHAR(10),
  "ToTaxCurrencyRate"            NUMERIC       NOT NULL,
  "RoundAdj"                     NUMERIC,
  "FinalTotal"                   NUMERIC,
  "CalcDiscountOnUnitPrice"      CHAR(1),
  "TaxDocNo"                     VARCHAR(20),
  "TotalExTax"                   NUMERIC,
  "TaxableAmt"                   NUMERIC,
  "InclusiveTax"                 CHAR(1)       NOT NULL,
  "Footer1TaxRate"               NUMERIC,
  "Footer2TaxRate"               NUMERIC,
  "Footer3TaxRate"               NUMERIC,
  "TaxDate"                      TIMESTAMPTZ,
  "IsRoundAdj"                   CHAR(1)       NOT NULL,
  "RoundingMethod"               INTEGER       NOT NULL,
  "LocalTaxableAmt"              NUMERIC,
  "TaxCurrencyTax"               NUMERIC,
  "TaxCurrencyTaxableAmt"        NUMERIC,
  "MultiPrice"                   VARCHAR(8),
  "TaxBranchID"                  VARCHAR(8)
);

CREATE INDEX "idx_IV_DebtorCode"   ON "IV" ("DebtorCode");
CREATE INDEX "idx_IV_DocDate"      ON "IV" ("DocDate");
CREATE INDEX "idx_IV_LastModified" ON "IV" ("LastModified");
CREATE INDEX "idx_IV_Cancelled"    ON "IV" ("Cancelled");
```

---

#### `IVDTL` — Invoice Line Items
Primary key: `DtlKey`

```sql
CREATE TABLE "IVDTL" (
  "DtlKey"                BIGINT      PRIMARY KEY,
  "FOCDtlKey"             BIGINT,
  "DocKey"                BIGINT      NOT NULL,
  "Seq"                   INTEGER     NOT NULL,
  "Indent"                SMALLINT,
  "FontStyle"             VARCHAR(8),
  "MainItem"              CHAR(1)     NOT NULL,
  "Numbering"             VARCHAR(6),
  "ItemCode"              VARCHAR(30),
  "Location"              VARCHAR(8),
  "BatchNo"               VARCHAR(20),
  "Description"           VARCHAR(100),
  "FurtherDescription"    TEXT,
  "YourPONo"              VARCHAR(25),
  "YourPODate"            TIMESTAMPTZ,
  "PostToStockDate"       TIMESTAMPTZ,
  "ProjNo"                VARCHAR(10),
  "DeptNo"                VARCHAR(10),
  "UOM"                   VARCHAR(8),
  "UserUOM"               VARCHAR(8),
  "Qty"                   NUMERIC,
  "Rate"                  NUMERIC,
  "SmallestQty"           NUMERIC,
  "FOCQty"                NUMERIC,
  "SmallestUnitPrice"     NUMERIC,
  "UnitPrice"             NUMERIC,
  "UnitCost"              NUMERIC,
  "FOCUnitCost"           NUMERIC,
  "Discount"              VARCHAR(20),
  "DiscountAmt"           NUMERIC,
  "TaxType"               VARCHAR(14),
  "Tax"                   NUMERIC,
  "SubTotal"              NUMERIC,
  "LocalSubTotal"         NUMERIC,
  "BonusPoint"            NUMERIC,
  "PrintOut"              CHAR(1)     NOT NULL,
  "DtlType"               CHAR(1),
  "CalcByPercent"         NUMERIC,
  "AddToSubTotal"         CHAR(1)     NOT NULL,
  "FromDocType"           VARCHAR(2),
  "FromDocNo"             TEXT,
  "FromDocDtlKey"         BIGINT,
  "AccNo"                 VARCHAR(12),
  "FullTransferOption"    CHAR(1),
  "FullTransferFromDocList" TEXT,
  "SerialNoList"          TEXT,
  "PackageDocKey"         BIGINT,
  "ParentDtlKey"          BIGINT,
  "SubQty"                NUMERIC,
  "IsCalcBonusPoint"      CHAR(1),
  "SubTotalExTax"         NUMERIC,
  "LocalTax"              NUMERIC,
  "Guid"                  UUID        NOT NULL,
  "RuleNo"                BIGINT,
  "GoodsReturn"           CHAR(1),
  "TaxableAmt"            NUMERIC,
  "TaxAdjustment"         NUMERIC,
  "TaxExportCountry"      VARCHAR(50),
  "LocalSubTotalExTax"    NUMERIC,
  "ExtraDiscountAmt"      NUMERIC,
  "TaxRate"               NUMERIC,
  "LocalTaxAdjustment"    NUMERIC,
  "LocalTaxableAmt"       NUMERIC,
  "TaxCurrencyTax"        NUMERIC,
  "TaxCurrencyTaxableAmt" NUMERIC,
  "TaxPermitNo"           VARCHAR(20),
  "SalesExemptionNo"      VARCHAR(60),
  "SupplyPurchase"        CHAR(1),
  "TariffCode"            VARCHAR(12),
  "Desc2"                 VARCHAR(100),
  "TransferedQty"         NUMERIC     NOT NULL,
  "Transferable"          CHAR(1)     NOT NULL,
  "StockReceived"         CHAR(1)     NOT NULL
);

CREATE INDEX "idx_IVDTL_DocKey"   ON "IVDTL" ("DocKey");
CREATE INDEX "idx_IVDTL_ItemCode" ON "IVDTL" ("ItemCode");
```

---

#### `QT` — Quotations (1,455 rows)
Primary key: `DocKey`
> Same column structure as `IV`. Use the same template above — replace table name `IV` with `QT`. All column names and types are identical.

```sql
CREATE TABLE "QT" ( -- same columns as IV
  "DocKey" BIGINT PRIMARY KEY,
  -- ... copy all columns from IV schema above
  "Transferable" CHAR(1) NOT NULL,
  "TransferedAmt" NUMERIC,
  "CanTransferByValue" CHAR(1),
  "ToDtlKey" BIGINT,
  "FullTransferOption" CHAR(1)
);
CREATE INDEX "idx_QT_DebtorCode"   ON "QT" ("DebtorCode");
CREATE INDEX "idx_QT_DocDate"      ON "QT" ("DocDate");
CREATE INDEX "idx_QT_LastModified" ON "QT" ("LastModified");
```

#### `QTDTL` — Quotation Line Items
Primary key: `DtlKey` — same structure as `IVDTL`.

---

#### `SO` — Sales Orders (7 rows)
Primary key: `DocKey` — same structure as `IV`.

#### `SODTL` — Sales Order Line Items
Primary key: `DtlKey` — same structure as `IVDTL`.

---

#### `DO` — Delivery Orders (24 rows)
Primary key: `DocKey` — same structure as `IV`.

#### `DODTL` — Delivery Order Line Items
Primary key: `DtlKey` — same structure as `IVDTL`.

---

#### `CN` — Credit Notes (25 rows)
Primary key: `DocKey` — same structure as `IV` with one extra column:
```sql
"Reason" VARCHAR(80)
```

#### `CNDTL` — Credit Note Line Items
Primary key: `DtlKey` — same structure as `IVDTL`.

---

#### `PO` — Purchase Orders (331 rows)
Primary key: `DocKey`
> Same structure as `IV` but `DebtorCode`/`DebtorName` are replaced by `CreditorCode`/`CreditorName`. All other columns identical.

#### `PODTL` — Purchase Order Line Items
Primary key: `DtlKey` — same structure as `IVDTL`.

---

#### `Debtor` — Customer Master List
Primary key: `AutoKey`

```sql
CREATE TABLE "Debtor" (
  "AutoKey"                  BIGINT      PRIMARY KEY,
  "AccNo"                    VARCHAR(12) NOT NULL UNIQUE,
  "CompanyName"              VARCHAR(100),
  "Desc2"                    VARCHAR(100),
  "RegisterNo"               VARCHAR(30),
  "Address1"                 VARCHAR(40),
  "Address2"                 VARCHAR(40),
  "Address3"                 VARCHAR(40),
  "Address4"                 VARCHAR(40),
  "PostCode"                 VARCHAR(10),
  "DeliverAddr1"             VARCHAR(40),
  "DeliverAddr2"             VARCHAR(40),
  "DeliverAddr3"             VARCHAR(40),
  "DeliverAddr4"             VARCHAR(40),
  "DeliverPostCode"          VARCHAR(10),
  "Attention"                VARCHAR(40),
  "Phone1"                   VARCHAR(25),
  "Phone2"                   VARCHAR(25),
  "Fax1"                     VARCHAR(25),
  "Fax2"                     VARCHAR(25),
  "Mobile"                   VARCHAR(25),
  "AreaCode"                 VARCHAR(12),
  "SalesAgent"               VARCHAR(12),
  "DebtorType"               VARCHAR(20),
  "NatureOfBusiness"         VARCHAR(40),
  "WebURL"                   VARCHAR(80),
  "EmailAddress"             VARCHAR(200),
  "DisplayTerm"              VARCHAR(30)  NOT NULL,
  "CreditLimit"              NUMERIC,
  "AgingOn"                  CHAR(1),
  "StatementType"            CHAR(1),
  "CurrencyCode"             VARCHAR(5)   NOT NULL,
  "AllowExceedCreditLimit"   CHAR(1)      NOT NULL,
  "Note"                     TEXT,
  "ExemptNo"                 VARCHAR(60),
  "ExpiryDate"               TIMESTAMPTZ,
  "PriceCategory"            VARCHAR(12),
  "TaxType"                  VARCHAR(14),
  "DiscountPercent"          NUMERIC      NOT NULL,
  "DetailDiscount"           VARCHAR(20),
  "LastModified"             TIMESTAMPTZ  NOT NULL,
  "LastModifiedUserID"       VARCHAR(10)  NOT NULL,
  "CreatedTimeStamp"         TIMESTAMPTZ  NOT NULL,
  "CreatedUserID"            VARCHAR(10)  NOT NULL,
  "OverdueLimit"             NUMERIC,
  "HasBonusPoint"            CHAR(1)      NOT NULL,
  "OpeningBonusPoint"        NUMERIC,
  "QTBlockStatus"            SMALLINT,
  "SOBlockStatus"            SMALLINT,
  "DOBlockStatus"            SMALLINT,
  "IVBlockStatus"            SMALLINT,
  "CSBlockStatus"            SMALLINT,
  "QTBlockMessage"           VARCHAR(40),
  "SOBlockMessage"           VARCHAR(40),
  "DOBlockMessage"           VARCHAR(40),
  "IVBlockMessage"           VARCHAR(40),
  "CSBlockMessage"           VARCHAR(40),
  "ExternalLink"             TEXT,
  "IsGroupCompany"           CHAR(1)      NOT NULL,
  "IsActive"                 CHAR(1)      NOT NULL,
  "LastUpdate"               INTEGER      NOT NULL,
  "ContactInfo"              TEXT,
  "AccountGroup"             VARCHAR(12),
  "MarkupRatio"              NUMERIC,
  "TaxRegisterNo"            VARCHAR(20),
  "CalcDiscountOnUnitPrice"  CHAR(1),
  "GSTStatusVerifiedDate"    TIMESTAMPTZ,
  "InclusiveTax"             CHAR(1)      NOT NULL,
  "RoundingMethod"           INTEGER      NOT NULL,
  "SelfBilledApprovalNo"     VARCHAR(30),
  "Guid"                     UUID         NOT NULL,
  "IsTaxRegistered"          CHAR(1),
  "ReceiptWithholdingTaxCode"  VARCHAR(14),
  "PaymentWithholdingTaxCode"  VARCHAR(14),
  "MultiPrice"               VARCHAR(8),
  "AllowChangeMultiPrice"    CHAR(1),
  "TaxBranchID"              VARCHAR(8),
  "ServiceTaxRegisterNo"     VARCHAR(20),
  "CGBlockStatus"            SMALLINT,
  "CGBlockMessage"           VARCHAR(40)
);

CREATE INDEX "idx_Debtor_AccNo"        ON "Debtor" ("AccNo");
CREATE INDEX "idx_Debtor_IsActive"     ON "Debtor" ("IsActive");
CREATE INDEX "idx_Debtor_LastModified" ON "Debtor" ("LastModified");
```

---

#### `Creditor` — Supplier Master List
Primary key: `AutoKey`
> Same structure as `Debtor`. Replace `DebtorType` → `CreditorType`, `SalesAgent` → `PurchaseAgent`, and the block status columns:
```sql
"POBlockStatus"  SMALLINT,
"GNBlockStatus"  SMALLINT,
"PIBlockStatus"  SMALLINT,
"CPBlockStatus"  SMALLINT,
"PGBlockStatus"  SMALLINT,
"POBlockMessage" VARCHAR(40),
"GNBlockMessage" VARCHAR(40),
"PIBlockMessage" VARCHAR(40),
"CPBlockMessage" VARCHAR(40),
"PGBlockMessage" VARCHAR(40)
```

---

#### `Item` — Stock / Product Catalog
Primary key: `AutoKey`

```sql
CREATE TABLE "Item" (
  "AutoKey"             BIGINT      PRIMARY KEY,
  "ItemCode"            VARCHAR(30) NOT NULL UNIQUE,
  "DocKey"              BIGINT      NOT NULL,
  "Description"         VARCHAR(100),
  "Desc2"               VARCHAR(100),
  "FurtherDescription"  TEXT,
  "ItemGroup"           VARCHAR(8),
  "ItemType"            VARCHAR(12),
  "AssemblyCost"        NUMERIC,
  "LeadTime"            VARCHAR(40),
  "StockControl"        CHAR(1)     NOT NULL,
  "HasSerialNo"         CHAR(1)     NOT NULL,
  "HasBatchNo"          CHAR(1)     NOT NULL,
  "DutyRate"            NUMERIC     NOT NULL,
  "Taxtype"             VARCHAR(14),
  "Note"                TEXT,
  "Image"               TEXT,        -- base64-encoded binary from app
  "CostingMethod"       SMALLINT    NOT NULL,
  "SalesUOM"            VARCHAR(8)  NOT NULL,
  "PurchaseUOM"         VARCHAR(8)  NOT NULL,
  "ReportUOM"           VARCHAR(8)  NOT NULL,
  "LastModified"        TIMESTAMPTZ NOT NULL,
  "LastModifiedUserID"  VARCHAR(10) NOT NULL,
  "CreatedTimeStamp"    TIMESTAMPTZ NOT NULL,
  "CreatedUserID"       VARCHAR(10) NOT NULL,
  "IsActive"            CHAR(1)     NOT NULL,
  "LastUpdate"          INTEGER     NOT NULL,
  "SNFormatName"        VARCHAR(20),
  "IsCalcBonusPoint"    CHAR(1),
  "MarkupRatio"         NUMERIC,
  "HasPromoter"         CHAR(1)     NOT NULL,
  "GlobalCode"          VARCHAR(30),
  "ItemBrand"           VARCHAR(20),
  "ItemClass"           VARCHAR(20),
  "ItemCategory"        VARCHAR(20),
  "LeadTimeDay"         INTEGER,
  "ExternalLink"        TEXT,
  "Discontinued"        CHAR(1)     NOT NULL,
  "AutoUOMConversion"   CHAR(1),
  "BaseUOM"             VARCHAR(8)  NOT NULL,
  "BackOrderControl"    CHAR(1)     NOT NULL,
  "PurchaseTaxType"     VARCHAR(14),
  "TariffCode"          VARCHAR(12),
  "Guid"                UUID        NOT NULL,
  "IsSalesItem"         CHAR(1),
  "IsPurchaseItem"      CHAR(1),
  "IsPOSItem"           CHAR(1),
  "IsRawMaterialItem"   CHAR(1),
  "IsFinishGoodsItem"   CHAR(1),
  "MainSupplier"        VARCHAR(12),
  "ImageFileName"       VARCHAR(120)
);

CREATE INDEX "idx_Item_ItemCode"      ON "Item" ("ItemCode");
CREATE INDEX "idx_Item_IsActive"      ON "Item" ("IsActive");
CREATE INDEX "idx_Item_LastModified"  ON "Item" ("LastModified");
CREATE INDEX "idx_Item_ItemGroup"     ON "Item" ("ItemGroup");
```

---

### 3.4 Remaining 330 Tables

The remaining tables follow the same pattern. For each table:

1. **Determine the primary key** — look for `DocKey`, `DtlKey`, or `AutoKey` in the first columns
2. **Map types** using the table in section 3.1
3. **Create the table** with `PRIMARY KEY` on the detected key column
4. **Add the upsert** in the `POST /api/sync/:tableName` handler

Common table families and their key column:

| Table family | Examples | Primary key |
|---|---|---|
| Document headers | `IV`, `QT`, `SO`, `DO`, `PO`, `CN`, `DN` | `DocKey` |
| Document detail lines | `IVDTL`, `QTDTL`, `SODTL`, `DODTL`, `PODTL`, `CNDTL` | `DtlKey` |
| Master data | `Debtor`, `Creditor`, `Item`, `AccType`, `ItemGroup` | `AutoKey` |
| Other | `AccPeriod`, `DocNoFormat`, `Activity` | `AutoKey` or composite |

Tables with no obvious single PK (junction/log tables) — use `ON CONFLICT DO NOTHING` and treat all columns as the composite key.

---

## 4. Server Implementation Guide

### 4.1 Recommended request handler (pseudocode)

```js
// POST /api/sync/:tableName
app.post('/api/sync/:tableName', authenticate, async (req, res) => {
  const { tableName } = req.params;
  const { rows }      = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.json({ upserted: 0 });
  }

  const columns = Object.keys(rows[0]);
  const pk      = detectPrimaryKey(columns); // 'DocKey' | 'DtlKey' | 'AutoKey'

  let upserted = 0;
  for (const row of rows) {
    await db.query(buildUpsertSQL(tableName, columns, pk), Object.values(row));
    upserted++;
  }
  res.json({ upserted });
});
```

### 4.2 Batch insert for performance

For large tables (IVDTL can have 18,000+ rows), process rows in batches:

```js
const BATCH_SIZE = 500;
for (let i = 0; i < rows.length; i += BATCH_SIZE) {
  const batch = rows.slice(i, i + BATCH_SIZE);
  await upsertBatch(tableName, columns, pk, batch);
}
```

### 4.3 `char(1)` boolean handling

AutoCount stores booleans as `'T'` / `'F'` strings. You can store them as `CHAR(1)` in PostgreSQL as-is, or convert when inserting:

```js
// Option A: keep as-is (simpler, matches source)
CHAR(1) with 'T' / 'F'

// Option B: convert to boolean (more idiomatic PostgreSQL)
const pgVal = val === 'T' ? true : val === 'F' ? false : null;
```

Recommended: **Option A** (keep `CHAR(1)`) so the schema stays a 1-to-1 mirror of AutoCount and there is no risk of conversion errors.

---

## 5. Sync Behaviour Summary

| Aspect | Detail |
|---|---|
| Frequency | Every 5 minutes (configurable) |
| First sync | Syncs all rows from all 338 tables |
| Subsequent syncs | Only rows where `LastModified > lastSyncTime` (125 tables); full sync for the other 213 |
| Skips | Tables with 0 changed rows are skipped (no API call made) |
| Failure handling | Per-table: error is logged, sync continues with next table |
| Token expiry | Auto re-login on `401`, retries once |
| Crash recovery | `sync-state.json` is saved after each table — next run resumes correctly |

---

## 6. Security Checklist for the Server

- [ ] JWT tokens must expire (recommended: 24h, configurable)
- [ ] Validate `tableName` in `/api/sync/:tableName` against a whitelist of known table names — never interpolate raw user input into SQL
- [ ] Rate-limit the sync endpoint (the app sends one request per table per 5 minutes, so ~338 requests / 5 min = ~1 req/sec max)
- [ ] HTTPS only in production — the token and all data travel in plain JSON
- [ ] The sync user should have write-only permission to the `autocount_*` schema — no access to other application data

---

## 7. Quick Start Checklist

**Server team:**
- [ ] Implement `POST /api/auth/login` → returns `{ token, expiresIn }`
- [ ] Implement `POST /api/sync/:tableName` → upserts rows, returns `{ upserted }`
- [ ] Create PostgreSQL tables from schemas in section 3.3 (start with `IV`, `IVDTL`, `Debtor`, `Item`)
- [ ] Create remaining tables using the type mapping in section 3.1
- [ ] Test with a small payload manually before connecting the app

**Desktop app team:**
- [ ] `npm install mssql` in the project folder
- [ ] Run `npx electron .`
- [ ] Enter API URL, username, password in the login screen
- [ ] Observe the sync log — each table should show ✓ with a row count
