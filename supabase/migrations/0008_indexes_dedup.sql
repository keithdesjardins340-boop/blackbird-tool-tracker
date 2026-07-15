-- Performance indexes matching the hot query paths. (The listing/time index on
-- price_snapshots already exists from 0001.) Product-URL dedup is enforced going
-- forward by normalizeUrl() in the scraper + writer function, on top of the
-- existing unique(dealer_id, product_url) constraint.

-- Runner: "active listings for this dealer/tool".
create index if not exists tool_listings_active_tool_idx
  on tool_listings (tool_id) where active;

-- Auto-mapper: "unmapped tools, ordered by tier".
create index if not exists tools_unmapped_tier_idx
  on tools (tier) where auto_map_state is null;
