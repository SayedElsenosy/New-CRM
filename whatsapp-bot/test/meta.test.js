import test from 'node:test';
import assert from 'node:assert/strict';
import {metaConfig,encryptMetaToken,decryptMetaToken,metaLoginUrl,metaStateHash,normalizeMetaAdAccountId} from '../src/meta.js';

test('Meta token encryption round trips without exposing plaintext',()=>{
 const key='0123456789abcdef0123456789abcdef-secret',token='EAAB-test-sensitive-token';
 const encrypted=encryptMetaToken(token,key);
 assert.notEqual(encrypted,token);assert.equal(encrypted.includes(token),false);
 assert.equal(decryptMetaToken(encrypted,key),token);
 assert.throws(()=>decryptMetaToken(encrypted,key+'different'));
});

test('Meta configuration requires server secrets and graph version',()=>{
 const missing=metaConfig({});
 assert.equal(missing.configured,false);
 assert.ok(missing.missing.includes('META_APP_ID'));
 assert.ok(missing.missing.includes('META_GRAPH_VERSION'));
 const configured=metaConfig({
  META_APP_ID:'123',
  META_APP_SECRET:'secret',
  META_TOKEN_ENCRYPTION_KEY:'0123456789abcdef0123456789abcdef',
  META_GRAPH_VERSION:'v99.0',
  META_OAUTH_REDIRECT_URI:'https://crm.example.com/integrations/meta/callback'
 });
 assert.equal(configured.configured,true);
});

test('Meta OAuth URL requests read-only ads/business permissions and preserves state',()=>{
 const config=metaConfig({
  META_APP_ID:'123',
  META_APP_SECRET:'secret',
  META_TOKEN_ENCRYPTION_KEY:'0123456789abcdef0123456789abcdef',
  META_GRAPH_VERSION:'v99.0',
  META_OAUTH_REDIRECT_URI:'https://crm.example.com/integrations/meta/callback'
 });
 const url=new URL(metaLoginUrl({state:'state-12345678901234567890',config}));
 assert.equal(url.searchParams.get('client_id'),'123');
 assert.equal(url.searchParams.get('state'),'state-12345678901234567890');
 const scope=url.searchParams.get('scope').split(',');
 assert.ok(scope.includes('ads_read'));assert.ok(scope.includes('business_management'));
 assert.equal(url.searchParams.get('redirect_uri'),'https://crm.example.com/integrations/meta/callback');
});

test('Meta helpers normalize account ids and hash OAuth state',()=>{
 assert.equal(normalizeMetaAdAccountId('act_123456'),'123456');
 assert.equal(normalizeMetaAdAccountId('123456'),'123456');
 assert.equal(metaStateHash('abc'),metaStateHash('abc'));
 assert.notEqual(metaStateHash('abc'),metaStateHash('abd'));
});
