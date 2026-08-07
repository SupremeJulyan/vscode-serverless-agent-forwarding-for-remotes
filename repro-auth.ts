// 真实 connectSftp + 真实密码，完整流程（认证 + realpath）
import { connectSftp } from './src/sftp/client';
async function main() {
  try {
    const s = await connectSftp(
      { name: 'yxzy', ip: '10.68.0.101', user: 'nsyx_zhuyuan', port: 22, password: 'hpc_zy@2026.346' },
      false
    );
    const home = await s.realpath('.');
    console.log(`✅ 连接成功（${(s as { transport?: string }).transport ?? 'sftp'}）`);
    console.log(`✅ realpath('.') = ${home}`);
    const entries = await s.readDirectory(home);
    console.log(`✅ readDirectory ${entries.length} 项`);
    await s.close();
    console.log('✅ 全流程通过');
  } catch (e) {
    console.log(`❌ ${(e as Error).message}`);
  }
  process.exit(0);
}
main();
