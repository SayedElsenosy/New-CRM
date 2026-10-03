import 'dotenv/config';
import path from 'node:path';
import {database,createSerial} from './db.js';
import {WhatsAppConnection} from './whatsapp.js';
import {Worker} from './worker.js';
import {makeApi} from './api.js';
const db=database(),serial=createSerial();
const origins=(process.env.DASHBOARD_ORIGIN||'http://localhost:5173').split(',').map(x=>x.trim()).filter(Boolean);
if(process.env.RAILWAY_PUBLIC_DOMAIN)origins.push(`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
const sessionPath=path.resolve(process.env.SESSION_PATH||'./sessions');
let worker;
const connection=new WhatsAppConnection({sessionPath,onMessage:(client,msg)=>worker.receive(client,msg)});
worker=new Worker({db,connection,serial,sessionPath});
await worker.init();await connection.init();
const dashboardDist=process.env.DASHBOARD_DIST?path.resolve(process.env.DASHBOARD_DIST):null;
const app=makeApi({db,connection,worker,serial,origins,dashboardDist});
const server=app.listen(Number(process.env.PORT)||3001,'0.0.0.0',()=>console.log('Masar service ready'));
async function shutdown(){worker.stop();server.close();await connection.close();process.exit(0);}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
