export function withFirstAttribution(answers,referral){
 const current=answers&&typeof answers==='object'?answers:{};
 if(!referral||typeof referral!=='object'||current.__attribution)return current;
 return {...current,__attribution:referral};
}
