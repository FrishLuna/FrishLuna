import net from 'node:net'
const pid = process.argv[2]
const cmd = process.argv[3]
if (!pid || !cmd) { console.error('用法: node tools/send-cmd.mjs <pid> <json>'); process.exit(1) }
const sock = net.connect(`\\\\.\\pipe\\frishluna.${pid}.cmd`)
sock.on('connect', () => {
  sock.write(cmd)
  setTimeout(() => process.exit(0), 400)
})
sock.on('error', (e) => { console.error('pipe-error:', e.message); process.exit(1) })
setTimeout(() => { console.error('timeout'); process.exit(2) }, 5000)
