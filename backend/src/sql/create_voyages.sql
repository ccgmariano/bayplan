create table if not exists voyages (
  id serial primary key,
  vessel_name text not null,
  voyage_code text not null,
  created_at timestamptz not null default now()
);
