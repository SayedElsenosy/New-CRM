-- Conversational area advisor: group one physical place with its operating modes.
-- The columns are derived automatically from area names so old admin screens keep working.
begin;

alter table public.masar_areas
 add column if not exists place_key text not null default '',
 add column if not exists work_mode text not null default 'general';

alter table public.masar_areas drop constraint if exists masar_areas_work_mode_check;
alter table public.masar_areas add constraint masar_areas_work_mode_check
 check(work_mode in ('general','market','restaurants','other'));

create or replace function public.masar_shape_area_identity()
returns trigger language plpgsql set search_path=public as $$
declare v text;
begin
 v=lower(trim(translate(coalesce(new.name,''),'أإآةى','اااهي')));
 v=regexp_replace(v,'\s+',' ','g');

 if v ~ '(مطاعم|مطعم|restaurant|restaurants)' then
  new.work_mode='restaurants';
 elsif v ~ '(ماركت|سوبر[[:space:]]*ماركت|market)' then
  new.work_mode='market';
 elsif coalesce(new.work_mode,'') not in ('other') then
  new.work_mode='general';
 end if;

 v=regexp_replace(v,'(مطاعم|مطعم|restaurant|restaurants|ماركت|سوبر[[:space:]]*ماركت|market)',' ','gi');
 v=regexp_replace(v,'\s+',' ','g');
 v=regexp_replace(trim(v),'^مدينه[[:space:]]+','','i');
 new.place_key=trim(v);
 return new;
end $$;

drop trigger if exists masar_shape_area_identity_trigger on public.masar_areas;
create trigger masar_shape_area_identity_trigger
before insert or update of name on public.masar_areas
for each row execute function public.masar_shape_area_identity();

-- Backfill all existing rows through the same canonicalizer.
update public.masar_areas set name=name;

create index if not exists masar_areas_office_place_mode
 on public.masar_areas(office_id,place_key,work_mode,active);

commit;
