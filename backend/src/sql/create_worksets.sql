create table if not exists worksets (
  id serial primary key,
  voyage_id integer not null references voyages(id) on delete cascade,
  type text not null check (type in ('OPERATION','PARALISATION')),
  created_at timestamptz not null default now()
);
