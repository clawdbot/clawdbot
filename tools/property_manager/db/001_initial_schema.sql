CREATE SCHEMA IF NOT EXISTS propertymanager;

CREATE TABLE IF NOT EXISTS propertymanager.maintenance_categories (
    id uuid PRIMARY KEY,
    name text NOT NULL UNIQUE,
    icon text NOT NULL,
    color_name text NOT NULL,
    is_built_in boolean NOT NULL DEFAULT false,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS propertymanager.maintenance_tasks (
    id uuid PRIMARY KEY,
    area text NOT NULL,
    item text NOT NULL,
    category_name text NOT NULL DEFAULT 'House',
    priority text NOT NULL DEFAULT 'Medium',
    frequency text NOT NULL DEFAULT 'As Needed',
    task_description text,
    response_instructions text,
    supplies_needed text,
    notes text,
    result_notes text,
    estimated_minutes integer,
    warning_days integer NOT NULL,
    critical_days integer NOT NULL,
    last_done timestamptz NOT NULL,
    next_due timestamptz NOT NULL,
    send_telegram_update boolean NOT NULL DEFAULT true,
    include_in_daily_briefing boolean NOT NULL DEFAULT true,
    alert_if_overdue boolean NOT NULL DEFAULT true,
    is_active boolean NOT NULL DEFAULT true,

    part_url text,
    vendor text,
    part_number text,
    part_cost numeric(10,2),
    annual_cost numeric(10,2),

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT maintenance_tasks_area_item_unique UNIQUE (area, item)
);

CREATE TABLE IF NOT EXISTS propertymanager.maintenance_completions (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES propertymanager.maintenance_tasks(id) ON DELETE CASCADE,
    completed_at timestamptz NOT NULL,
    note text,
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO propertymanager.maintenance_categories
(id, name, icon, color_name, is_built_in, sort_order)
VALUES
('00000000-0000-0000-0000-000000000001', 'Pool', 'drop.fill', 'blue', true, 10),
('00000000-0000-0000-0000-000000000002', 'Hot Tub', 'bubbles.and.sparkles.fill', 'cyan', true, 20),
('00000000-0000-0000-0000-000000000003', 'Grounds', 'leaf.fill', 'green', true, 30),
('00000000-0000-0000-0000-000000000004', 'Equipment', 'wrench.and.screwdriver.fill', 'orange', true, 40),
('00000000-0000-0000-0000-000000000005', 'House', 'house.fill', 'purple', true, 50),
('00000000-0000-0000-0000-000000000006', 'Safety', 'shield.fill', 'red', true, 60),
('00000000-0000-0000-0000-000000000007', 'Tractor', 'gearshape.2.fill', 'brown', true, 70)
ON CONFLICT (name) DO NOTHING;
