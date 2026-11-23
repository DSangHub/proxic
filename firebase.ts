import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { HttpRequest } from '@azure/functions';
function app(){ if(getApps().length) return getApps()[0]!; const privateKey=process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g,'\n'); if(!process.env.FIREBASE_PROJECT_ID||!process.env.FIREBASE_CLIENT_EMAIL||!privateKey) throw new Error('Firebase configuration missing'); return initializeApp({credential:cert({projectId:process.env.FIREBASE_PROJECT_ID,clientEmail:process.env.FIREBASE_CLIENT_EMAIL,privateKey})}); }
export async function requireUser(req:HttpRequest){ const h=req.headers.get('authorization'); if(!h?.startsWith('Bearer ')) throw new AuthError(); const decoded=await getAuth(app()).verifyIdToken(h.slice(7), true); return {uid:decoded.uid,email:decoded.email??null}; }
export class AuthError extends Error { status=401; constructor(){super('Unauthorized');} }
