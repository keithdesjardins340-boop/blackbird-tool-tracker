-- Source-pluggable auto-mapping (plan item 2.1).
--
-- Auto-map was hardwired to "search a dealer" via that dealer's scrape adapter
-- (only KMS/SearchSpring qualified). To widen coverage we decouple "where do I
-- SEARCH for a dealer's products" from "which adapter PRICES a product page".
--
--   search_source — which registered search source powers auto-mapping for this
--                   dealer (scraper/src/sources/*). NULL = not auto-mapped (the
--                   dealer is still scraped/priced normally; it just isn't
--                   discovered automatically). This column is now the single
--                   opt-in switch for auto-mapping, replacing the adapter.autoMap
--                   flag as the selection gate.
--   platform       — storefront family (shopify | woocommerce | magento | acl |
--                    generic | ...). Informational for now; future adapters key
--                    off it. NULL = unknown/unclassified.
--
-- Only KMS is auto-map-enabled today, so we backfill its search_source and leave
-- every other dealer NULL — behaviour is identical to before this migration.
alter table dealers add column if not exists search_source text;
alter table dealers add column if not exists platform text;

update dealers set search_source = 'searchspring', platform = 'magento'
where name = 'KMS Tools';
