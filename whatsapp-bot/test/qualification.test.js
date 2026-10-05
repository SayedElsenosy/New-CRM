import test from 'node:test';
import assert from 'node:assert/strict';
import {qualificationFor,funnelFor,cost,ratio,stageReached} from '../src/qualification.js';
import {completion} from '../src/domain.js';
import {withFirstAttribution} from '../src/attribution.js';

const q=(id,field_key,kind='text',required=true,active=true)=>({id,field_key,kind,required,active,position:1});
const answer=(value,kind='text',display=String(value))=>({value,kind,display});
const areas=[
 {id:'oct',name:'أكتوبر',zone:'WEST',recruitment_eligible:true,active:true},
 {id:'zayed',name:'الشيخ زايد',zone:'WEST',recruitment_eligible:true,active:true},
 {id:'outside',name:'المنصورة',zone:'UNKNOWN',recruitment_eligible:false,active:true}
];

test('motorcycle plus eligible work area is qualified',()=>{
 const questions=[q('m','has_motorcycle','yes_no'),q('w','preferred_work_area','area')];
 const applicant={answers:{m:answer(true,'yes_no','نعم'),w:answer('oct','area','أكتوبر')}};
 const result=qualificationFor(applicant,questions,areas);
 assert.equal(result.motorcycle_qualified,true);
 assert.equal(result.geo_qualified,true);
 assert.equal(result.geo_basis,'preferred_work_area');
 assert.equal(result.preferred_work_area,'أكتوبر');
 assert.equal(result.zone,'WEST');
 assert.equal(result.qualified_candidate,true);
 assert.equal(result.overall_status,'qualified');
});

test('candidate without motorcycle is not qualified and recruitment stage is untouched',()=>{
 const questions=[q('m','has_motorcycle','yes_no'),q('w','preferred_work_area','area')];
 const applicant={recruitment_stage:'review',answers:{m:answer(false,'yes_no','لا'),w:answer('oct','area','أكتوبر')}};
 const result=qualificationFor(applicant,questions,areas);
 assert.equal(result.qualified_candidate,false);
 assert.deepEqual(result.reasons,['no_motorcycle']);
 assert.equal(applicant.recruitment_stage,'review');
});

test('ineligible work area is geo not qualified',()=>{
 const questions=[q('m','has_motorcycle','yes_no'),q('w','preferred_work_area','area')];
 const applicant={answers:{m:answer(true,'yes_no','نعم'),w:answer('outside','area','المنصورة')}};
 const result=qualificationFor(applicant,questions,areas);
 assert.equal(result.motorcycle_qualified,true);
 assert.equal(result.geo_qualified,false);
 assert.equal(result.geo_status,'outside');
 assert.equal(result.qualified_candidate,false);
 assert.deepEqual(result.reasons,['no_eligible_work_area']);
});

test('explicit no-work-area marker is not qualified',()=>{
 const questions=[q('m','has_motorcycle','yes_no'),q('w','preferred_work_area','area')];
 const applicant={answers:{
  m:answer(true,'yes_no','نعم'),
  w:{value:'__none__',display:'لا توجد منطقة مناسبة',kind:'area',no_eligible_work_area:true,work_area_eligible:false}
 }};
 const result=qualificationFor(applicant,questions,areas);
 assert.equal(result.geo_qualified,false);
 assert.equal(result.qualified_candidate,false);
 assert.deepEqual(result.reasons,['no_eligible_work_area']);
});

test('unanswered motorcycle or work area remains pending',()=>{
 const questions=[q('m','has_motorcycle','yes_no'),q('w','preferred_work_area','area')];
 let result=qualificationFor({answers:{}},questions,areas);
 assert.equal(result.overall_status,'pending');
 result=qualificationFor({answers:{m:answer(true,'yes_no')}},questions,areas);
 assert.equal(result.geo_qualified,null);
 assert.equal(result.qualified_candidate,null);
});

test('residence is informational only and never changes qualification',()=>{
 const questions=[q('m','has_motorcycle','yes_no'),q('w','preferred_work_area','area'),q('r','residence_area','text',false,true)];
 const applicant={answers:{
  m:answer(true,'yes_no','نعم'),
  w:answer('oct','area','أكتوبر'),
  r:{value:'الشرقية',display:'الشرقية',kind:'text',geo_status:'outside',geo_confirmed_outside:true}
 }};
 const result=qualificationFor(applicant,questions,areas);
 assert.equal(result.residence_area,'الشرقية');
 assert.equal(result.preferred_work_area,'أكتوبر');
 assert.equal(result.geo_qualified,true);
 assert.equal(result.qualified_candidate,true);
 assert.deepEqual(result.reasons,[]);
 assert.equal(result.checks.residence.required,false);
});

test('complete application can still be not qualified because of work area',()=>{
 const questions=[q('m','has_motorcycle','yes_no'),q('w','preferred_work_area','area')];
 const applicant={answers:{m:answer(true,'yes_no'),w:answer('outside','area','المنصورة')}};
 assert.equal(completion(questions,applicant.answers,areas).complete,true);
 assert.equal(qualificationFor(applicant,questions,areas).qualified_candidate,false);
});

test('required active license and shift checks participate only when explicitly enabled',()=>{
 const questions=[q('m','has_motorcycle','yes_no'),q('w','preferred_work_area','area'),q('l','motorcycle_license','yes_no'),q('s','shift_acceptance','yes_no')];
 let applicant={answers:{m:answer(true,'yes_no'),w:answer('zayed','area','الشيخ زايد'),l:answer(true,'yes_no')}};
 assert.equal(qualificationFor(applicant,questions,areas,{qualification_require_motorcycle_license:true,qualification_require_shift:true}).overall_status,'pending');
 applicant.answers.s=answer(false,'yes_no','لا');
 const result=qualificationFor(applicant,questions,areas,{qualification_require_motorcycle_license:true,qualification_require_shift:true});
 assert.equal(result.overall_status,'not_qualified');
 assert.ok(result.reasons.includes('shift_not_accepted'));
});

test('disabled or optional extra conditions do not block qualification',()=>{
 const questions=[q('m','has_motorcycle','yes_no'),q('w','preferred_work_area','area'),q('l','motorcycle_license','yes_no',false,true),q('s','shift_acceptance','yes_no',true,false)];
 const applicant={answers:{m:answer(true,'yes_no'),w:answer('oct','area','أكتوبر')}};
 assert.equal(qualificationFor(applicant,questions,areas).qualified_candidate,true);
});

test('archived work area keeps historical geo qualification',()=>{
 const questions=[q('m','has_motorcycle','yes_no'),q('w','preferred_work_area','area')];
 const applicant={answers:{
  m:answer(true,'yes_no','نعم'),
  w:{value:'deleted-area',display:'أكتوبر',kind:'area',archived_area:true,archived_area_name:'أكتوبر',archived_area_zone:'WEST',archived_area_recruitment_eligible:true}
 }};
 const result=qualificationFor(applicant,questions,[]);
 assert.equal(result.preferred_work_area,'أكتوبر');
 assert.equal(result.zone,'WEST');
 assert.equal(result.geo_qualified,true);
 assert.equal(result.qualified_candidate,true);
});

test('deleted area snapshots keep historical completion valid',()=>{
 const questions=[q('w','preferred_work_area','area')];
 const applicant={answers:{w:{value:'deleted-area',display:'أكتوبر',kind:'area',archived_area:true,archived_area_name:'أكتوبر',archived_area_zone:'WEST',archived_area_recruitment_eligible:true}}};
 assert.equal(completion(questions,applicant.answers,[]).complete,true);
});

test('funnel keeps existing geo metric name while using work-area qualification',()=>{
 const rows=[
  {recruitment_stage:'hired',qualification:{motorcycle_qualified:true,geo_qualified:true,qualified_candidate:true}},
  {recruitment_stage:'accepted',qualification:{motorcycle_qualified:true,geo_qualified:true,qualified_candidate:true}},
  {recruitment_stage:'interview',qualification:{motorcycle_qualified:true,geo_qualified:true,qualified_candidate:true}},
  {recruitment_stage:'review',qualification:{motorcycle_qualified:false,geo_qualified:true,qualified_candidate:false}},
  {recruitment_stage:'rejected',qualification:{motorcycle_qualified:true,geo_qualified:false,qualified_candidate:false}}
 ];
 const f=funnelFor(rows,700);
 assert.equal(f.applicants,5);
 assert.equal(f.motorcycle_qualified,4);
 assert.equal(f.geo_qualified,4);
 assert.equal(f.qualified,3);
 assert.equal(f.interview,3);
 assert.equal(f.accepted,2);
 assert.equal(f.hired,1);
 assert.equal(f.rejected,1);
 assert.equal(f.costs.per_hired,700);
 assert.equal(f.rates.qualified_rate,60);
 assert.equal(stageReached('hired','interview'),true);
 assert.equal(stageReached('rejected','interview'),false);
});

test('cost calculations are null on zero denominators or missing spend',()=>{
 assert.equal(cost(0,10),null);
 assert.equal(cost(100,0),null);
 assert.equal(ratio(2,0),null);
 const f=funnelFor([{recruitment_stage:'new',qualification:{motorcycle_qualified:null,geo_qualified:null,qualified_candidate:null}}],0);
 assert.equal(f.costs.per_applicant,null);
 assert.equal(f.costs.per_hired,null);
});

test('cost per hired rounds correctly',()=>{
 assert.equal(cost(700,17),41.18);
});

test('first attribution is never replaced by a later referral',()=>{
 const first={source_id:'111',ctwa_clid:'first'};
 const later={source_id:'222',ctwa_clid:'later'};
 const initial=withFirstAttribution({},first);
 const next=withFirstAttribution(initial,later);
 assert.equal(next.__attribution.source_id,'111');
 assert.equal(next.__attribution.ctwa_clid,'first');
 assert.equal(next,initial);
});
