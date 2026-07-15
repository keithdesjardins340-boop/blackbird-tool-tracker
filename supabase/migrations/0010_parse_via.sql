-- Record HOW each snapshot's price was extracted (json-ld | meta | markup | …),
-- so a dealer that breaks or drifts to a different layout is quick to diagnose
-- from the data instead of guessing. Nullable; older rows stay null.
alter table price_snapshots add column if not exists parse_via text;
