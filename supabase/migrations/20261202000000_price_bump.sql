-- Higher shop prices (DECISIONS 90, owner 2026-11-26). Catalogue rows only:
-- buy_avalanche_item reads the price from avalanche_items, so nothing else
-- changes. Items already owned stay owned.
-- Mirrors RIDERS, BOARDS and TRAILS in src/config.js (tests/catalog.mjs checks them).

-- Snowflake prices.
update public.avalanche_items i set cost = v.cost
from (values
  ('rider', 'pine', 500),
  ('rider', 'blush', 1000),
  ('rider', 'frost', 5000),
  ('board', 'sunrise', 1000),
  ('board', 'mint', 2000),
  ('board', 'aurora', 2000)
) as v(type, id, cost)
where i.type = v.type and i.id = v.id;

-- Shards prices.
update public.avalanche_items i set shards = v.shards
from (values
  ('rider', 'galaxy', 1500),
  ('rider', 'gold', 1500),
  ('board', 'galaxy', 1000),
  ('board', 'gold', 1000),
  ('trail', 'rainbow', 500),
  ('trail', 'aurora', 500),
  ('trail', 'ember', 500),
  ('trail', 'stardust', 500),
  ('trail', 'neon', 500)
) as v(type, id, shards)
where i.type = v.type and i.id = v.id;
