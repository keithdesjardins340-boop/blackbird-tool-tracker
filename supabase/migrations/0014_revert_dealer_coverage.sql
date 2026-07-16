-- Revert the dealer-coverage build-out (migrations 0012 + 0013) for the
-- manual-first pivot. The source registry, Shopify adapter, and catalog sync are
-- removed from the tree; this restores the dealers schema to its 0011 shape and
-- removes the two speculatively-onboarded Shopify dealers (they had 0 listings).
--
-- Append-only history: 0012/0013 stay in the migrations folder as applied history;
-- this migration undoes their effects. pg_trgm is left installed (harmless).
--
-- KMS's search_source/platform values disappear with the columns — the parked
-- auto-mapper selects dealers by adapter.autoMap again (its pre-0012 behavior),
-- so nothing depends on these columns anymore.

drop table if exists dealer_catalog;

delete from dealers where name in ('Gray Tools', 'MPR Tools');

alter table dealers drop column if exists search_source;
alter table dealers drop column if exists platform;
