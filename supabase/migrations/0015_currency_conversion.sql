-- Currency conversion: everything comparable in CAD.
--
-- Until now `price_cad` was whatever number the page showed and `currency` was
-- never written (it just defaulted to 'CAD') — so a USD price from a US site was
-- stored as if it were Canadian dollars. That silently corrupted best-price
-- comparison, the 90-day average, and the anomaly gate.
--
-- New contract for price_snapshots:
--   price_cad         ALWAYS CAD. Converted when the source wasn't CAD.
--   currency          the SOURCE currency as declared by the page ('USD', 'CAD'…).
--                     Still defaults to 'CAD' (an undeclared price is assumed CAD).
--   price_original    the amount as shown on the page, before conversion.
--   fx_rate           the rate applied to get CAD (1 when already CAD).
--
-- Conversion happens at write time (scraper + writer function) against the Bank
-- of Canada's daily rate, so history keeps the rate that was actually used rather
-- than being re-derived later.
alter table price_snapshots add column if not exists price_original numeric;
alter table price_snapshots add column if not exists fx_rate numeric;

comment on column price_snapshots.price_cad is 'Always CAD; converted from currency/price_original using fx_rate.';
comment on column price_snapshots.currency is 'Source currency declared by the page; CAD assumed when undeclared.';
comment on column price_snapshots.price_original is 'Amount as shown on the page, before FX conversion.';
comment on column price_snapshots.fx_rate is 'Rate applied to reach CAD (1 when the source was already CAD).';
