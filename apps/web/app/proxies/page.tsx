'use client';
import {useState} from 'react'; import {submitProxyRequest} from '../../lib/api';
export default function Proxies(){const [message,setMessage]=useState(''); const [result,setResult]=useState(''); async function go(){setResult(JSON.stringify(await submitProxyRequest(message),null,2));} return <main><h1>Assign a Proxy</h1><div className="card"><textarea value={message} onChange={e=>setMessage(e.target.value)} placeholder="Example: Remind me to renew my vehicle registration"/><p><button onClick={go} disabled={!message}>Assign</button></p>{result&&<pre>{result}</pre>}</div></main>}
