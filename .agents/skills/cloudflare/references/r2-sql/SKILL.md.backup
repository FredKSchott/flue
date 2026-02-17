# Cloudflare R2 SQL Skill

Guide for using Cloudflare R2 SQL - serverless distributed query engine for Apache Iceberg tables in R2 Data Catalog.

## Overview

R2 SQL is Cloudflare's serverless distributed analytics query engine for querying Apache Iceberg tables in R2 Data Catalog. Features:
- Serverless - no clusters to manage
- Distributed - leverages Cloudflare's global network
- Zero egress fees - query from any cloud/region
- Open beta - free during beta (standard R2 storage costs apply)

## Core Concepts

### Apache Iceberg Table Format
- Open table format for large-scale analytics datasets
- ACID transactions for reliable concurrent reads/writes
- Schema evolution - add/rename/drop columns without rewriting data
- Optimized metadata - avoids full table scans via indexed metadata
- Supported by Spark, Trino, Snowflake, DuckDB, ClickHouse, PyIceberg

### R2 Data Catalog
- Managed Apache Iceberg catalog built into R2 bucket
- Exposes standard Iceberg REST catalog interface
- Single source of truth for table metadata
- Tracks table state via immutable snapshots
- Supports multiple query engines safely accessing same tables

### Architecture
**Query Planner**:
- Top-down metadata investigation
- Multi-layer pruning (partition-level, column-level, row-group level)
- Streaming pipeline - execution starts before planning completes
- Early termination - stops when result complete without full scan
- Uses partition stats and column stats (min/max, null counts)

**Query Execution**:
- Coordinator distributes work to workers across Cloudflare network
- Workers run Apache DataFusion for parallel query execution
- Arrow IPC format for inter-process communication
- Parquet column pruning - reads only required columns
- Ranged reads from R2 for efficiency

**Aggregation Strategies**:
- Scatter-gather - for simple aggregations (sum, count, avg)
- Shuffling - for ORDER BY/HAVING on aggregates via hash partitioning

## Setup & Configuration

### 1. Enable R2 Data Catalog

CLI:
```bash
npx wrangler r2 bucket catalog enable <bucket-name>
```

Note the Warehouse name and Catalog URI from output.

Dashboard:
1. R2 Object Storage → Select bucket
2. Settings tab → R2 Data Catalog → Enable
3. Note Catalog URI and Warehouse name

### 2. Create API Token

Required permissions: R2 Admin Read & Write (includes R2 SQL Read)

Dashboard:
1. R2 Object Storage → Manage API tokens
2. Create API token → Admin Read & Write
3. Save token value

### 3. Configure Environment

```bash
export WRANGLER_R2_SQL_AUTH_TOKEN=<your-token>
```

Or `.env` file:
```
WRANGLER_R2_SQL_AUTH_TOKEN=<your-token>
```

## Common Code Patterns

### Wrangler CLI Query

```bash
npx wrangler r2 sql query "<warehouse-name>" "
  SELECT * 
  FROM namespace.table_name 
  WHERE condition 
  LIMIT 10"
```

### PyIceberg Setup

```python
from pyiceberg.catalog.rest import RestCatalog

catalog = RestCatalog(
    name="my_catalog",
    warehouse="<WAREHOUSE>",
    uri="<CATALOG_URI>",
    token="<TOKEN>",
)

# Create namespace
catalog.create_namespace_if_not_exists("default")
```

### Create Table

```python
import pyarrow as pa

# Define schema
df = pa.table({
    "id": [1, 2, 3],
    "name": ["Alice", "Bob", "Charlie"],
    "score": [80.0, 92.5, 88.0],
})

# Create table
table = catalog.create_table(
    ("default", "people"),
    schema=df.schema,
)
```

### Append Data

```python
table.append(df)
```

### Query Table

```python
# Scan and convert to Pandas
scanned = table.scan().to_arrow()
print(scanned.to_pandas())
```

## SQL Reference

### Query Structure

```sql
SELECT column_list | aggregation_function
FROM table_name
WHERE conditions
[GROUP BY column_list]
[HAVING conditions]
[ORDER BY partition_key [DESC | ASC]]
[LIMIT number]
```

### Schema Discovery

```sql
-- List namespaces
SHOW DATABASES;
SHOW NAMESPACES;

-- List tables
SHOW TABLES IN namespace_name;

-- Describe table
DESCRIBE namespace_name.table_name;
```

### SELECT Patterns

```sql
-- All columns
SELECT * FROM ns.table;

-- Specific columns
SELECT user_id, timestamp, status FROM ns.table;

-- With conditions
SELECT * FROM ns.table 
WHERE timestamp BETWEEN '2025-01-01T00:00:00Z' AND '2025-01-31T23:59:59Z'
  AND status = 200
LIMIT 100;

-- Complex conditions
SELECT * FROM ns.table 
WHERE (status = 404 OR status = 500) 
  AND method = 'POST'
  AND user_agent IS NOT NULL
ORDER BY timestamp DESC;
```

### Aggregations

Supported functions: COUNT(*), SUM(col), AVG(col), MIN(col), MAX(col)

```sql
-- Count by group
SELECT department, COUNT(*)
FROM ns.sales_data
GROUP BY department;

-- Multiple aggregates
SELECT region, MIN(price), MAX(price), AVG(price)
FROM ns.products
GROUP BY region
ORDER BY AVG(price) DESC;

-- With HAVING filter
SELECT category, SUM(amount)
FROM ns.sales
WHERE sale_date >= '2024-01-01'
GROUP BY category
HAVING SUM(amount) > 10000
LIMIT 10;
```

### Data Types

| Type | Description | Example |
|------|-------------|---------|
| integer | Whole numbers | 1, 42, -10 |
| float | Decimals | 1.5, 3.14 |
| string | Text (quoted) | 'hello', 'GET' |
| boolean | true/false | true, false |
| timestamp | RFC3339 | '2025-01-01T00:00:00Z' |
| date | YYYY-MM-DD | '2025-01-01' |

### Operators

Comparison: =, !=, <, <=, >, >=, LIKE, BETWEEN, IS NULL, IS NOT NULL
Logical: AND (higher precedence), OR (lower precedence)

### ORDER BY Limitations

**CRITICAL**: ORDER BY only supports partition key columns

```sql
-- Valid if timestamp is partition key
SELECT * FROM ns.logs ORDER BY timestamp DESC LIMIT 100;

-- Invalid if column not in partition key
SELECT * FROM ns.logs ORDER BY user_id;  -- ERROR
```

### LIMIT Defaults

- Range: 1 to 10,000
- Default: 500 if not specified

## Pipelines Integration

### Create Pipeline with Data Catalog Sink

Schema file (`schema.json`):
```json
{
  "fields": [
    {"name": "user_id", "type": "string", "required": true},
    {"name": "event_type", "type": "string", "required": true},
    {"name": "amount", "type": "float64", "required": false}
  ]
}
```

Setup:
```bash
npx wrangler pipelines setup
```

Configuration:
- Pipeline name: ecommerce
- Enable HTTP endpoint: yes
- Schema: Load from file → schema.json
- Destination: Data Catalog Table
- R2 bucket: your-bucket
- Namespace: default
- Table name: events
- Catalog token: <your-token>
- Compression: zstd
- Roll file time: 10 seconds (dev), 300+ (prod)

### Send Data to Pipeline

```bash
curl -X POST https://{stream-id}.ingest.cloudflare.com \
  -H "Content-Type: application/json" \
  -d '[
    {
      "user_id": "user_123",
      "event_type": "purchase",
      "amount": 29.99
    }
  ]'
```

## Common Use Cases

### Log Analytics
- Ingest logs via Pipelines to Iceberg table
- Partition by day(timestamp) for efficient queries
- Query specific time ranges with automatic pruning
- Aggregate by status codes, endpoints, user agents

```sql
SELECT status, COUNT(*)
FROM logs.http_requests
WHERE timestamp BETWEEN '2025-01-01T00:00:00Z' AND '2025-01-31T23:59:59Z'
  AND method = 'GET'
GROUP BY status
ORDER BY COUNT(*) DESC;
```

### Fraud Detection
- Stream transaction events to catalog
- Query suspicious patterns with WHERE filters
- Aggregate by location, merchant, time windows

```sql
SELECT location, COUNT(*), AVG(amount)
FROM fraud.transactions
WHERE is_fraud = true
  AND transaction_timestamp >= '2025-01-01'
GROUP BY location
HAVING COUNT(*) > 10;
```

### Business Intelligence
- ETL data into partitioned Iceberg tables
- Run analytical queries across large datasets
- Generate reports with GROUP BY aggregations
- No egress fees when querying from BI tools

```sql
SELECT 
  department, 
  SUM(revenue) as total_revenue,
  AVG(revenue) as avg_revenue
FROM sales.transactions
WHERE sale_date >= '2024-01-01'
GROUP BY department
ORDER BY SUM(revenue) DESC
LIMIT 10;
```

## Performance Optimization

### Partitioning Strategy
- Choose partition key based on common query patterns
- Typical: day(timestamp), hour(timestamp), region, category
- Enables metadata pruning to skip entire partitions
- Required for ORDER BY optimization

### Query Optimization
- Use WHERE filters to leverage partition/column stats
- Specify LIMIT to enable early termination
- ORDER BY partition key columns only
- Filter on high-selectivity columns first

### Data Organization
- Smaller files → slower queries (overhead)
- Larger files → better compression, fewer metadata ops
- Recommended: 100-500MB Parquet files after compression
- Use appropriate roll intervals in Pipelines (300+ seconds for prod)

### File Pruning
Automatic at three levels:
1. Partition-level: Skip manifests not matching query
2. File-level: Skip Parquet files via column stats
3. Row-group level: Skip row groups within files

## Iceberg Metadata Structure

```
bucket/
  metadata/
    snap-{id}.avro          # Snapshot (points to manifest list)
    {uuid}-m0.avro          # Manifest file (lists data files + stats)
    version-hint.text       # Current metadata version
    v{n}.metadata.json      # Table metadata (schema, snapshots)
  data/
    00000-0-{uuid}.parquet  # Data files
```

**Metadata hierarchy**:
1. Table metadata JSON - schema, partition spec, snapshot log
2. Snapshot - points to manifest list
3. Manifest list - partition stats for each manifest
4. Manifest files - column stats for each data file
5. Parquet files - row group stats in footer

## Limitations & Best Practices

### Current Limitations (Open Beta)
- ORDER BY only on partition key columns
- COUNT(*) only - COUNT(column) not supported
- No aliases in SELECT
- No subqueries, joins, or CTEs
- No nested column access
- LIMIT max 10,000

### Best Practices
- Partition by time dimension for time-series data
- Use BETWEEN for time ranges (leverages partition pruning)
- Combine filters with AND for better pruning
- Set appropriate LIMIT based on use case
- Use compression (zstd recommended)
- Monitor query performance and adjust partitioning

### Type Safety
- Quote string values: 'value'
- Use RFC3339 for timestamps: '2025-01-01T00:00:00Z'
- Use YYYY-MM-DD for dates: '2025-01-01'
- No implicit type conversions

## Connecting Other Engines

R2 Data Catalog supports standard Iceberg REST catalog API.

### Spark (Scala)
```scala
val spark = SparkSession.builder()
  .config("spark.sql.catalog.my_catalog", "org.apache.iceberg.spark.SparkCatalog")
  .config("spark.sql.catalog.my_catalog.catalog-impl", "org.apache.iceberg.rest.RESTCatalog")
  .config("spark.sql.catalog.my_catalog.uri", catalogUri)
  .config("spark.sql.catalog.my_catalog.token", token)
  .config("spark.sql.catalog.my_catalog.warehouse", warehouse)
  .getOrCreate()
```

### Snowflake
- Create external Iceberg catalog connection
- Configure with Catalog URI and R2 credentials
- Query tables via SQL interface

### DuckDB, Trino, ClickHouse
- Supported via Iceberg REST catalog protocol
- Refer to engine-specific documentation for configuration

## Pricing (Future)

Currently in open beta - no charges beyond standard R2 costs.

Planned future pricing:
- R2 storage: $0.015/GB-month
- Class A operations: $4.50/million
- Class B operations: $0.36/million
- Catalog operations: $9.00/million (create table, get metadata, etc)
- Compaction: $0.05/GB + $4.00/million objects processed
- Egress: $0 (always free)

30+ days notice before billing begins.

## Troubleshooting

### Common Errors

**"ORDER BY column not in partition key"**
- Only partition key columns can be used in ORDER BY
- Check table partition spec with DESCRIBE
- Remove ORDER BY or adjust table partitioning

**"Token authentication failed"**
- Verify WRANGLER_R2_SQL_AUTH_TOKEN is set
- Ensure token has R2 Admin Read & Write + SQL Read permissions
- Token may be expired - create new one

**"Table not found"**
- Verify namespace exists: SHOW DATABASES
- Check table name: SHOW TABLES IN namespace
- Ensure catalog enabled on bucket

**"No data returned"**
- Check WHERE conditions match data
- Verify time range in BETWEEN clause
- Try removing filters to confirm data exists

### Performance Issues

**Slow queries**:
- Check partition pruning effectiveness
- Reduce LIMIT if scanning too much data
- Ensure filters on partition key columns
- Review Parquet file sizes (aim for 100-500MB)

**Query timeout**:
- Add more restrictive WHERE filters
- Reduce LIMIT
- Consider better partitioning strategy

## Resources

- Docs: https://developers.cloudflare.com/r2-sql/
- Data Catalog: https://developers.cloudflare.com/r2/data-catalog/
- Blog: https://blog.cloudflare.com/r2-sql-deep-dive/
- Discord: https://discord.cloudflare.com/

## Key Reminders

1. R2 SQL queries ONLY Apache Iceberg tables in R2 Data Catalog
2. Enable catalog on bucket before use
3. Create API token with R2 + catalog permissions
4. Partition by time for time-series data
5. ORDER BY limited to partition key columns
6. Use LIMIT and WHERE for optimal performance
7. Zero egress fees - query from anywhere
8. Open beta - free during testing phase
9. Serverless - no infrastructure management
10. Leverage Cloudflare's global network for distributed execution
