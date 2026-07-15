-- Add a notes column (the tool list carries useful per-item notes) and switch
-- the natural key from (brand, model_number) to item name — in this dataset the
-- "Model / Part #" is descriptive spec text, not a unique dealer SKU (the real
-- SKU is resolved per dealer by the link finder into tool_listings.sku).

alter table tools add column if not exists notes text;
drop index if exists tools_brand_model_uidx;
create index if not exists tools_name_idx on tools (lower(name));
