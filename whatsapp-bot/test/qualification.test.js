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

test('motorcycle plus eligible October residence is qualified',()=>{
 const questions=[q('m','has_motorcycle','yes_no'),q('r','residence_area','text')];
 const applicant={answers:{m:answer(true,'yes_no','نعم'),r:answer('أكتوبر','text','أكتوبر')}};
 const result=qualificationFor(applicant,questions,areas);
 assert.equal(result.motorcycle_qualified,true);
 assert.equal(result.geo_qualified,true);
 assert.equal(result.zone,'WEST');
 assert.equal(result.qualified_candidate,true);
 assert.equal(result.overall_status,'qualified');
});

test('candidate without motorcycle is not qualified and is not rejected',()=>{
 const questions=[q('m','has_motorcycle','yes_no'),q('r','residence_area','text')];
 const applicant={recruitment_stage:'review',answers:{m:answer(false,'yes_no','لا'),r:answer('أكتوبر')}};
 const result=qualificationFor(applicant,questions,areas);
 assert.equal(result.qualified_candidate,false);
 assert.deepEqual(result.reasons,['no_motorcycle']);
 assert.equal(applicant.recruitment_stage,'review');
});

test('motorcycle owner outside supported residence area is geo not qualified',()=>{
 const questions=[q('m','has_motorcycle','yes_no'),q('r','residence_area','text')];
 const applicant={answers:{m:answer(true,'yes_no','نعم'),r:answer('المنصورة')}};
 const result=qualificationFor(applicant,questions,areas);
 assert.equal(result.motorcycle_qualified,true);
 assert.equal(result.geo_qualified,false);
 assert.equal(result.geo_status,'outside');
 assert.equal(result.qualified_candidate,false);
 assert.ok(result.reasons.includes('residence_outside_hiring_zones'));
});

test('unanswered candidate remains pending rather than not qualified',()=>{
 const questions=[q('m','has_motorcycle','yes_no'),q('r','residence_area','text')];
 const result=qualificationFor({answers:{}},questions,areas);
 assert.equal(result.motorcycle_qualified,null);
 assert.equal(result.geo_qualified,null);
 assert.equal(result.qualified_candidate,null);
 assert.equal(result.overall_status,'pending');
});

test('complete application can still be not qualified',()=>{
 const questions=[q('m','has_motorcycle','yes_no'),q('r','residence_area','text')];
 const applicant={answers:{m:answer(false,'yes_no','لا'),r:answer('أكتوبر')}};
 assert.equal(completion(questions,applicant.answers,areas).complete,true);
 assert.equal(qualificationFor(applicant,questions,areas).qualified_candidate,false);
});

test('required active license and shift checks participate in qualification',()=>{
 const questions=[q('m','has_motorcycle','yes_no'),q('r','residence_area','text'),q('l','motorcycle_license','yes_no'),q('s','shift_acceptance','yes_no')];
 let applicant={answers:{m:answer(true,'yes_no'),r:answer('زايد'),l:answer(true,'yes_no')}};
 assert.equal(qualificationFor(applicant,questions,areas).overall_status,'pending');
 applicant.answers.s=answer(false,'yes_no','لا');
 const result=qualificationFor(applicant,questions,areas);
 assert.equal(result.overall_status,'not_qualified');
 assert.ok(result.reasons.includes('shift_not_accepted'));
});

test('disabled or optional extra conditions do not block qualification',()=>{
 const questions=[q('m','has_motorcycle','yes_no'),q('r','residence_area','text'),q('l','motorcycle_license','yes_no',false,true),q('s','shift_acceptance','yes_no',true,false)];
 const applicant={answers:{m:answer(true,'yes_no'),r:answer('أكتوبر')}};
 assert.equal(qualificationFor(applicant,questions,areas).qualified_candidate,true);
});

test('funnel counts later stages cumulatively and calculates cost per hire',()=>{
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
