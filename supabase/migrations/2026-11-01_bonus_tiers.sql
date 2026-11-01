-- Разовая замена шкалы бонусов за пополнение (по заданию владельца, 01.11.2026).
-- Заявки, созданные раньше, сохраняют свой «замороженный» бонус.
update settings set value = jsonb_build_object(
  'enabled', true, 'max_percent', 20,
  'tiers', '[{"min":1000,"max":4999,"percent":5,"enabled":true},
             {"min":5000,"max":9999,"percent":10,"enabled":true},
             {"min":10000,"max":19999,"percent":15,"enabled":true},
             {"min":20000,"max":null,"percent":20,"enabled":true}]'::jsonb)
where key = 'bonus';
select value from settings where key = 'bonus';
