-- Recruitment performance funnel, qualification rules, ad zones and spend sync metadata.
-- Run after 012_office_admin_scoped_config.sql. Safe to rerun and preserves existing data.
begin;

alter table public.masar_ads
 add column if not exists zone text not null default 'UNKNOWN',
 add column if not exists spend_source text not null default 'manual',
 add column if not exists spend_synced_at timestamptz;

alter table public.masar_ads drop constraint if exists masar_ads_zone_check;
alter table public.masar_ads
 add constraint masar_ads_zone_check check(zone in ('WEST','EAST','NORTH_CENTRAL','UNKNOWN'));
alter table public.masar_ads drop constraint if exists masar_ads_spend_source_check;
alter table public.masar_ads
 add constraint masar_ads_spend_source_check check(spend_source in ('manual','meta'));

alter table public.masar_areas
 add column if not exists recruitment_eligible boolean not null default false,
 add column if not exists zone text not null default 'UNKNOWN';

alter table public.masar_areas drop constraint if exists masar_areas_zone_check;
alter table public.masar_areas
 add constraint masar_areas_zone_check check(zone in ('WEST','EAST','NORTH_CENTRAL','UNKNOWN'));

create index if not exists masar_ads_zone on public.masar_ads(zone,campaign_id);
create index if not exists masar_areas_recruitment_zone on public.masar_areas(office_id,recruitment_eligible,zone);

-- Preserve the old question answers (answers are keyed by question UUID) while giving
-- measurement questions stable field keys. Do not overwrite an already-created canonical key.
update public.masar_questions q
set field_key='preferred_work_area'
where q.field_key='area'
  and not exists (
   select 1 from public.masar_questions x
   where x.office_id is not distinct from q.office_id
     and x.field_key='preferred_work_area'
  );

update public.masar_questions q
set field_key='has_motorcycle'
where q.field_key='motorcycle'
  and not exists (
   select 1 from public.masar_questions x
   where x.office_id is not distinct from q.office_id
     and x.field_key='has_motorcycle'
  );

update public.masar_questions q
set field_key='motorcycle_license'
where q.field_key='license'
  and not exists (
   select 1 from public.masar_questions x
   where x.office_id is not distinct from q.office_id
     and x.field_key='motorcycle_license'
  );

-- Add a dedicated residence question to each office. It is text so a candidate can name
-- an area that is not one of the work-area buttons; qualification then matches it against
-- the office's editable area catalog.
do $$
declare o record; insert_pos integer;
begin
 for o in select id from public.masar_offices order by created_at,id loop
  if not exists(select 1 from public.masar_questions where office_id=o.id and field_key='residence_area') then
   select position into insert_pos
   from public.masar_questions
   where office_id=o.id and field_key='preferred_work_area'
   order by position,id limit 1;

   if insert_pos is null then
    select coalesce(max(position),0)+1 into insert_pos from public.masar_questions where office_id=o.id;
   else
    update public.masar_questions set position=position+1 where office_id=o.id and position>=insert_pos;
   end if;

   insert into public.masar_questions(label,field_key,kind,required,active,position,office_id)
   values('ساكن فين حاليًا؟ اكتب اسم المنطقة أو الحي.','residence_area','text',true,true,insert_pos,o.id);
  end if;
 end loop;
end $$;

-- Seed only confident zone matches. Admin can edit both zone and eligibility later.
update public.masar_areas
set zone='WEST',recruitment_eligible=true
where zone='UNKNOWN' and recruitment_eligible=false
  and lower(trim(name)) in (
   'أكتوبر','اكتوبر','6 أكتوبر','6 اكتوبر','٦ أكتوبر','٦ اكتوبر',
   'الشيخ زايد','زايد','الهرم','حدائق الأهرام','حدائق الاهرام',
   'الفردوس','حدائق أكتوبر','حدائق اكتوبر'
  );

update public.masar_areas
set zone='EAST',recruitment_eligible=true
where zone='UNKNOWN' and recruitment_eligible=false
  and lower(trim(name)) in (
   'التجمع','التجمع الأول','التجمع الاول','التجمع الثالث','التجمع الخامس',
   'الرحاب','مدينتي','الشروق','مصر الجديدة','مصر الجديده'
  );

update public.masar_areas
set zone='NORTH_CENTRAL',recruitment_eligible=true
where zone='UNKNOWN' and recruitment_eligible=false
  and lower(trim(name)) in (
   'مدينة نصر','مدينه نصر','النزهة','النزهه','المقطم','مدينة العبور','مدينه العبور','العبور'
  );

commit;
