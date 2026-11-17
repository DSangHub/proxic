import './globals.css';
import Link from 'next/link';
import { AuthProvider } from './auth-provider';
export const metadata={title:'Proxic',description:'Assign a Proxy. Reclaim your time.'};
export default function Layout({children}:{children:React.ReactNode}) { return <html lang="en"><body><nav><b>PROXIC</b><Link href="/dashboard">Dashboard</Link><Link href="/proxies">Proxies</Link><Link href="/approvals">Approvals</Link></nav><AuthProvider>{children}</AuthProvider></body></html> }
