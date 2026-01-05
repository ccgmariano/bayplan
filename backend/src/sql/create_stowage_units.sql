create table if not exists stowage_units (
  id serial primary key,
  import_id integer not null references edi_imports(id) on delete cascade,
  container_no text not null,
  iso_type text,
  bay integer,
  row integer,
  tier integer,
  area text check (area in ('DECK','HOLD')),
  raw_pos text,
  created_at timestamptz not null default now()
);
