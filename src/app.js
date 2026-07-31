require("dotenv").config();
const {
  CloudClient,
  FileTokenStore,
  logger: sdkLogger,
} = require("cloud189-sdk");
const recording = require("log4js/lib/appenders/recording");
const accounts = require("../accounts");
const { mask, delay } = require("./utils");
const push = require("./push");
const { log4js, cleanLogs, catLogs } = require("./logger");
const tokenDir = ".token";

sdkLogger.configure({
  isDebugEnabled: process.env.CLOUD189_VERBOSE === "1",
});

// === 新增：绿色能量签到函数 (最终修复版) ===
const doGreenTask = async (cloudClient, logger) => {
  const activityId = "ACT2024cztx";
  let summary = ""; // 用于存储返回给推送的精简信息 

  try {
    const sessionKey = await cloudClient.getSessionKey();
    const commonHeaders = {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        'Referer': 'https://m.cloud.189.cn/zt/2024/green-task-system/index.html',
        'Host': 'm.cloud.189.cn'
    };

    // --- 步骤1: 执行签到 ---
    const signUrl = "https://m.cloud.189.cn/market/signInNew.action";
    const signRes = await cloudClient.request.get(signUrl, {
      searchParams: { sessionKey, activityId },
      headers: commonHeaders,
    });
    const signData = JSON.parse(signRes.body);

    if (signData.result === true || signData.status === 0) {
       logger.info("🌿 活动签到：成功执行");
    } else {
       logger.warn(`⚠️ 签到返回异常: ${JSON.stringify(signData)}`);
    }

    // --- 步骤2: 获取连签天数 ---
    const daysUrl = "https://m.cloud.189.cn/market/signInNewInfo.action";
    const daysRes = await cloudClient.request.get(daysUrl, {
      searchParams: { sessionKey, activityId },
      headers: commonHeaders
    });
    const daysData = JSON.parse(daysRes.body);
    const signDays = daysData.data || 0; 

    // --- 步骤3: 查询当前能量 ---
    const infoUrl = "https://m.cloud.189.cn/market/getGreenLevelList.action";
    const infoRes = await cloudClient.request.get(infoUrl, {
      searchParams: { sessionKey, activityId },
      headers: commonHeaders
    });
    const infoData = JSON.parse(infoRes.body);

    // --- 最终日志输出与推送文本拼接 ---
    if (infoData.data && infoData.data.userScore !== undefined) {
        const scoreMsg = `🌱 当前绿色能量: ${infoData.data.userScore}g (本周连签 ${signDays} 天)`;
        const levelMsg = `🏅 当前绿色等级: ${infoData.data.userMaxLevelNo || '未知'}`;
        
        // 打印详细日志
        logger.info(scoreMsg); 
        logger.info(levelMsg); 
        
        // 【关键修复1】将能量和等级合并，准备推送到电报
        summary = `${scoreMsg}\n${levelMsg}`; 
    } else {
        logger.info("📄 能量查询数据不完整");
        summary = "🌿 绿色能量: 查询失败";
    }

  } catch (e) {
    if (e.response) {
        logger.error(`❌ 绿色能量请求失败 [${e.response.statusCode}]: ${e.response.body}`);
    } else {
        logger.error(`❌ 绿色能量任务出错: ${e.message}`);
    }
    summary = "🌿 绿色能量: ❌ 失败";
  }

  // 【关键修复2】把 return 移出 catch 大括号，放在函数的最后面
  return summary; 
};

// 个人任务签到
const doUserTask = async (cloudClient, logger) => {
  const result = await cloudClient.userSign()
  const netdiskBonus = result.isSign? 0: result.netdiskBonus
  const msg = `☁️ 空间签到: 获得 ${netdiskBonus}M`;
  logger.info(msg); // 保持详细日志
  return msg;       // 【关键】返回精简信息
  //logger.info(`☁️ 空间签到: 获得 ${netdiskBonus}M 空间`);
};

const run = async (userName, password, userSizeInfoMap, logger) => {
  if (userName && password) {
    const before = Date.now();
    try {
      logger.log("📅 开始执行");
      const cloudClient = new CloudClient({
        username: userName,
        password,
        token: new FileTokenStore(`${tokenDir}/${userName}.json`),
      });
      const beforeUserSizeInfo = await cloudClient.getUserSizeInfo();

      // 获取任务的返回值 (注意：因为数组里绿色能量在前，所以接收时 greenMsg 在前)
      const [greenMsg, userMsg] = await Promise.all([
          doGreenTask(cloudClient, logger),
          doUserTask(cloudClient, logger)
      ]);
      
      // 将精简信息存入 Map，稍后给推送用
      userSizeInfoMap.set(userName, {
        cloudClient,
        userSizeInfo: beforeUserSizeInfo,
        logger,
        // 【优化】用 \n 换行，让电报的排版更整齐好看
        summaryMsg: `${userMsg}\n${greenMsg}` 
      });

      // 【关键修复3】删除了这里多余的第二次 await Promise.all() 调用

    } catch (e) {
      if (e.response) {
        logger.log(`请求失败: ${e.response.statusCode}, ${e.response.body}`);
      } else {
        logger.error(e);
      }
      if (e.code === "ECONNRESET" || e.code === "ETIMEDOUT") {
        logger.error("请求超时");
        throw e;
      }
    } finally {
      logger.log(
        `⏰ 执行完毕, 耗时 ${((Date.now() - before) / 1000).toFixed(2)} 秒`
      );
    }
  }
};

// 开始执行程序
async function main() {
  //  用于统计实际容量变化
  const userSizeInfoMap = new Map();
  let pushContent = ""; // 【新增】专门用于推送的字符串
  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index];
    const { userName, password } = account;
    const userNameInfo = mask(userName, 3, 7);
    const logger = log4js.getLogger(userName);
    logger.addContext("user", userNameInfo);
    await run(userName, password, userSizeInfoMap, logger);
  }

  //数据汇总
  for (const [
    userName,
    { cloudClient, userSizeInfo, logger, summaryMsg }, // 取出 summaryMsg
  ] of userSizeInfoMap) {
    const afterUserSizeInfo = await cloudClient.getUserSizeInfo();

    // 计算容量变化
    const cloudChange = ((afterUserSizeInfo.cloudCapacityInfo.totalSize - userSizeInfo.cloudCapacityInfo.totalSize) / 1024 / 1024).toFixed(2);
    const familyChange = ((afterUserSizeInfo.familyCapacityInfo.totalSize - userSizeInfo.familyCapacityInfo.totalSize) / 1024 / 1024).toFixed(2);
    // 1. 还是照常打印详细日志到控制台
    logger.log(
      `个人容量：⬆️  ${(
        (afterUserSizeInfo.cloudCapacityInfo.totalSize -
          userSizeInfo.cloudCapacityInfo.totalSize) /
        1024 /
        1024
      ).toFixed(2)}M/${(
        afterUserSizeInfo.cloudCapacityInfo.totalSize /
        1024 /
        1024 /
        1024
      ).toFixed(2)}G`,
      `家庭容量：⬆️  ${(
        (afterUserSizeInfo.familyCapacityInfo.totalSize -
          userSizeInfo.familyCapacityInfo.totalSize) /
        1024 /
        1024
      ).toFixed(2)}M/${(
        afterUserSizeInfo.familyCapacityInfo.totalSize /
        1024 /
        1024 /
        1024
      ).toFixed(2)}G`
    );

    // 2. 【新增】拼装精简推送内容
    const simpleName = mask(userName, 3, 7);
    pushContent += `📱 账号: ${simpleName}\n${summaryMsg}\n📈 容量: ☁️${cloudChange}M | 🏠${familyChange}M\n\n`;
  }
  return pushContent; // 返回给最底部的调用者
}

// === 修改底部的执行入口 ===
(async () => {
  try {
    // 接收 main 返回的精简内容
    const simplePushMsg = await main();
    await delay(1000);
    
    // 获取详细日志（用于保存或调试，如果你想在推送里完全隐藏详细日志，就不要用 logs 变量）
    const logs = catLogs(); 
    
    // 【修改这里】
    // 方案A：只推送精简信息（推荐）
    if (simplePushMsg) {
        await push("天翼云盘签到日报", simplePushMsg);
    }

    // 方案B：如果你既想要精简信息放在最上面，又想保留下面的长日志，就用这个：
    // await push("天翼云盘签到日报", simplePushMsg + "\n============\n详细日志:\n" + logs);

  } finally {
    recording.erase();
    cleanLogs();
  }
})();
