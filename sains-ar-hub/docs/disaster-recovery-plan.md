# SAINS AR Hub — Disaster Recovery Plan

## Status: TEMPLATE
Actual DR testing requires the BTP production environment.

## Recovery Objectives
- **RPO** (Recovery Point Objective): 4 hours
- **RTO** (Recovery Time Objective): 2 hours

## Backup Strategy
- **HANA Cloud**: Automatic backups every 6 hours (BTP managed)
- **PostgreSQL (Supabase)**: Point-in-time recovery, daily snapshots
- **Application code**: Git repository (GitHub)
- **Configuration**: BTP Credential Store + xs-security.json in repo

## Failover Procedures
1. HANA Cloud: Multi-AZ built-in, automatic failover
2. Application: BTP CF auto-restart on crash, 2-instance minimum (mta.yaml)
3. Fly.io (staging): Single instance, manual redeploy from GitHub

## Testing Schedule
- DR drill: quarterly (after production go-live)
- Backup restore test: monthly
