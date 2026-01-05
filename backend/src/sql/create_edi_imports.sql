create table if not exists edi_imports (
  id serial primary key,
  voyage_id integer not null references voyages(id) on delete cascade,
  workset_id integer not null references worksets(id) on delete cascade,
  filename text,
  message_type text,
  created_at timestamptz not null default now()
);
