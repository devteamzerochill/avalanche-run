-- Gold skin (DECISIONS 83): a Shards rider and board in the top price tier.
-- Catalogue rows only; buy_avalanche_item and select_avalanche_item already
-- handle any Shards item, so nothing else changes:
--   buy_avalanche_item('rider', 'gold')    debit 750 Shards, own and wear it
--   buy_avalanche_item('board', 'gold')    debit 350 Shards, own and wear it
-- Mirrors RIDERS and BOARDS in src/config.js (tests/catalog.mjs checks them).
insert into public.avalanche_items (type, id, cost, shards) values
  ('rider', 'gold', -1, 750),
  ('board', 'gold', -1, 350);
