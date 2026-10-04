import test from 'node:test';
import assert from 'node:assert/strict';
import {validExpoPushToken} from '../src/push.js';

test('Expo push token validation accepts official token shapes only',()=>{
 assert.equal(validExpoPushToken('ExponentPushToken[abcdefghijklmnop]'),true);
 assert.equal(validExpoPushToken('ExpoPushToken[abcdefghijklmnop]'),true);
 assert.equal(validExpoPushToken('ExponentPushToken[x]'),false);
 assert.equal(validExpoPushToken('https://example.com/token'),false);
 assert.equal(validExpoPushToken(''),false);
});
