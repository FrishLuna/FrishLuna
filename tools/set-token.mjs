import { saveToken, isFirstRun, describe } from '../app/server/auth-store.js'

const token = process.argv[2]

if (!token || process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log('用法：node tools/set-token.mjs 你的令牌（6~64 位）')
  process.exit(token ? 0 : 1)
}
if (token.length < 6 || token.length > 64) {
  console.error('令牌长度必须在 6~64 位之间，当前 ' + token.length + ' 位')
  process.exit(1)
}

saveToken(token, { firstRun: false })
console.log('✅ 令牌已更新，立即生效（无需重启面板）。')
console.log('   存储：' + JSON.stringify({ ...describe(), firstRun: isFirstRun() }))
console.log('   提醒：令牌只存哈希，这次设完只有你自己知道 —— 请妥善保管。')
