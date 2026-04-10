# SAAB to AR Hub Data Migration

## Overview
Migration scripts for transferring historical data from the retiring SAAB system to the SAINS AR Hub.

## Status: TEMPLATE
Actual SAAB schema discovery is required during the Realisasi phase. These templates document the expected migration approach.

## Approach
1. Extract from SAAB (Oracle/SQL Server) using native export tools
2. Transform using field-mapping.csv
3. Validate using validate.js checksums
4. Load into AR Hub via CDS bulk INSERT

## Files
- `field-mapping.csv` — SAAB → AR Hub field mapping (template)
- `validate.js` — Post-migration validation script (template)
