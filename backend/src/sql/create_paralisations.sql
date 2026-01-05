create table if not exists paralisations (
  id serial primary key,
  workset_id integer not null references worksets(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  reason text not null,
  notes text,
  created_at timestamptz not null default now()
);
