-- Part-number harvester: when a dealer product page is scraped, we can often
-- read the manufacturer part number (JSON-LD mpn/gtin/sku, or HD's modelNumber).
-- Store it on the listing so the dashboard can offer a one-tap "Set part #" for
-- tools that still have no PN — turning a VERIFY item into an SKU-trackable one.
alter table tool_listings add column if not exists mpn text;
