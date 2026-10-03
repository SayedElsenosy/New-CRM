-- Allow WhatsApp voice notes to be stored alongside existing applicant documents.
-- Run after previous migrations. Safe to rerun.
begin;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values(
 'masar-documents',
 'masar-documents',
 false,
 10485760,
 array[
  'image/jpeg','image/png','image/webp','application/pdf',
  'audio/ogg','audio/mpeg','audio/mp4','audio/aac','audio/wav'
 ]
)
on conflict(id) do update set
 public=false,
 file_size_limit=greatest(storage.buckets.file_size_limit,10485760),
 allowed_mime_types=excluded.allowed_mime_types;

commit;
