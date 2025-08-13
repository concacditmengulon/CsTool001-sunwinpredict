const Fastify = require("fastify");
const cors = require("@fastify/cors");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

// ==================== Cấu hình cơ bản ====================
const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOjAsImNhblZpZXdTdGF0IjpmYWxzZSwiZGlzcGxheU5hbWUiOiJhcGlzdW53aW52YyIsImJvdCI6MCwiaXNNZXJjaGFudCI6ZmFsc2UsInZlcmlmaWVkQmFua0FjY291bnQiOmZhbHNlLCJwbGF5RXZlbnRMb2JieSI6ZmFsc2UsImN1c3RvbWVySWQiOjI3NjQ3ODE3MywiYWZmSWQiOiJkOTNkM2Q4NC1mMDY5LTRiM2YtOGRhYy1iNDcxNmE4MTIxNDMiLCJiYW5uZWQiOmZhbHNlLCJicmFuZCI6InN1bi53aW4iLCJ0aW1lc3RhbXAiOjE3NTM0NDM3MjM2NjIsImxvY2tHYW1lcyI6W10sImFtb3VudCI6MCwibG9ja0NoYXQiOmZhbHNlLCJwaG9uZVZlcmlmaWVkIjpmYWxzZSwiaXBBZGRyZXNzIjoiMjAwMTplZTA6NTcwODo3NzAwOjhhZjM6YWJkMTpmZTJhOmM2MmMiLCJtdXRlIjpmYWxzZSwiYXZhdGFyIjoiaHR0cHM6Ly9pbWFnZXMuc3dpbnNob3AubmV0L2ltYWdlcy9hdmF0YXIvYXZhdGFyXzIwLnBuZyIsInBsYXRmb3JtSWQiOjUsInVzZXJJZCI6ImQ5M2QzZDg0LWYwNjktNGIzZi04ZGFjLWI0NzE2YTgxMjE0MyIsInJlZ1RpbWUiOjE3NTIwNDU4OTMyOTIsInBob25lIjoiIiwiZGVwb3NpdCI6ZmFsc2UsInVzZXJuYW1lIjoiU0NfYXBpc3Vud2luMTIzIn0.a-KRvIGfMqxtBq3WenudxP8pFx7mxj33iIZm-AklInk";
const fastify = Fastify({ logger: false });
const PORT = process.env.PORT || 3001;
const HISTORY_FILE = path.join(__dirname, 'taixiu_history.json');

// Biến toàn cục để lưu trữ dữ liệu
let rikResults = [];
let rikCurrentSession = null;
let rikWS = null;
let rikIntervalCmd = null;
let modelPredictions = {};
let modelPerformance = {};

// ==================== Các hàm hỗ trợ ====================
function getTX(d1, d2, d3) {
  return d1 + d2 + d3 >= 11 ? "Tài" : "Xỉu";
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      rikResults = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      console.log(`📚 Loaded ${rikResults.length} history records`);
    }
  } catch (err) {
    console.error('Error loading history:', err);
  }
}

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(rikResults), 'utf8');
  } catch (err) {
    console.error('Error saving history:', err);
  }
}

function decodeBinaryMessage(buffer) {
  try {
    const str = buffer.toString();
    if (str.startsWith("[")) return JSON.parse(str);
    let position = 0;
    let result = [];
    while (position < buffer.length) {
      const type = buffer.readUInt8(position++);
      if (type === 1) {
        const len = buffer.readUInt16BE(position);
        position += 2;
        result.push(buffer.toString('utf8', position, position + len));
        position += len;
      } else if (type === 2) {
        result.push(buffer.readInt32BE(position));
        position += 4;
      } else if (type === 3 || type === 4) {
        const len = buffer.readUInt16BE(position);
        position += 2;
        result.push(JSON.parse(buffer.toString('utf8', position, position + len)));
        position += len;
      } else {
        console.warn("Unknown binary type:", type);
        break;
      }
    }
    return result.length === 1 ? result[0] : result;
  } catch (e) {
    console.error("Binary decode error:", e);
    return null;
  }
}

// ==================== Thuật toán dự đoán "VIP" ====================

// [NÂNG CẤP] Tự động cập nhật trọng số
function updateModelPerformance(history) {
    const models = ['trend', 'short', 'mean', 'switch', 'bridge', 'cycle'];
    const newPerformance = {};

    for (const modelName of models) {
        const predictions = modelPredictions[modelName] || {};
        const lookback = 10;
        let correctPredictions = 0;
        let totalPredictions = 0;

        for (let i = 0; i < lookback && i < history.length - 1; i++) {
            const sessionId = history[history.length - (i + 2)].session;
            const predictionData = predictions[sessionId];
            
            if (predictionData && predictionData.prediction) {
                const actualResult = history[history.length - (i + 1)].result;
                const predictedResult = predictionData.prediction === 1 ? 'Tài' : 'Xỉu';
                if (predictedResult === actualResult) {
                    correctPredictions++;
                }
                totalPredictions++;
            }
        }
        
        const accuracy = totalPredictions > 0 ? correctPredictions / totalPredictions : 0.5;
        // Trọng số sẽ ưu tiên mô hình có độ chính xác cao hơn
        newPerformance[modelName] = Math.max(0.5, accuracy * 1.5);
    }
    modelPerformance = newPerformance;
}

// [MỚI] Mô hình phân tích mẫu lặp lại (Pattern Recognition)
function patternRecognitionModel(history) {
    if (!history || history.length < 15) {
        return { prediction: 0, reason: "Không đủ dữ liệu cho phân tích mẫu", score: 0 };
    }

    const last15Results = history.slice(-15).map(item => item.result);
    const patterns = {};
    let bestPattern = { pattern: null, count: 0, next: null };

    // Tìm kiếm các mẫu lặp lại có độ dài từ 3 đến 5
    for (let length = 3; length <= 5; length++) {
        for (let i = 0; i <= last15Results.length - length; i++) {
            const pattern = last15Results.slice(i, i + length).join(',');
            patterns[pattern] = (patterns[pattern] || 0) + 1;
            if (patterns[pattern] > bestPattern.count) {
                bestPattern.count = patterns[pattern];
                bestPattern.pattern = pattern.split(',');
                // Dự đoán kết quả tiếp theo dựa trên mẫu
                if (i + length < last15Results.length) {
                    bestPattern.next = last15Results[i + length];
                } else {
                    bestPattern.next = null;
                }
            }
        }
    }

    if (bestPattern.count >= 2 && bestPattern.next) {
        const prediction = bestPattern.next === 'Tài' ? 1 : 2;
        const reason = `Phát hiện mẫu lặp lại: [${bestPattern.pattern.join(',')}] → dự đoán ${bestPattern.next}`;
        // Điểm số dựa trên số lần lặp lại của mẫu
        const score = Math.min(1, bestPattern.count / 3);
        return { prediction, reason, score };
    }

    return { prediction: 0, reason: "Không tìm thấy mẫu lặp lại rõ ràng", score: 0 };
}


function detectStreakAndBreak(history) {
  if (!history || history.length === 0) return { streak: 0, currentResult: null, breakProb: 0 };
  let streak = 1;
  const currentResult = history[history.length - 1].result;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].result === currentResult) streak++;
    else break;
  }
  const last15Results = history.slice(-15).map(item => item.result);
  if (!last15Results.length) return { streak, currentResult, breakProb: 0 };
  const switches = last15Results.slice(1).reduce((count, result, index) => count + (result !== last15Results[index] ? 1 : 0), 0);
  const taiCount = last15Results.filter(result => result === 'Tài').length;
  const xiuCount = last15Results.filter(result => result === 'Xỉu').length;
  const imbalance = Math.abs(taiCount - xiuCount) / last15Results.length;
  let breakProb = 0;
  if (streak >= 8) breakProb = Math.min(0.6 + switches / 15 + imbalance * 0.15, 0.9);
  else if (streak >= 5) breakProb = Math.min(0.35 + switches / 10 + imbalance * 0.25, 0.85);
  else if (streak >= 3 && switches >= 7) breakProb = 0.3;
  return { streak, currentResult, breakProb };
}

function smartBridgeBreak(history) {
  if (!history || history.length < 3) return { prediction: 0, breakProb: 0, reason: 'Không đủ dữ liệu để bẻ cầu' };
  const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
  const last20Results = history.slice(-20).map(item => item.result);
  const last20Scores = history.slice(-20).map(item => item.score || 0);
  let finalBreakProb = breakProb;
  let reason = '';
  const avgScore = last20Scores.reduce((sum, score) => sum + score, 0) / (last20Scores.length || 1);
  const scoreDeviation = last20Scores.reduce((sum, score) => sum + Math.abs(score - avgScore), 0) / (last20Scores.length || 1);
  const last5Results = last20Results.slice(-5);
  const patternCounts = {};
  for (let i = 0; i <= last20Results.length - 3; i++) {
    const pattern = last20Results.slice(i, i + 3).join(',');
    patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
  }
  const mostCommonPattern = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
  const hasRepeatingPattern = mostCommonPattern && mostCommonPattern[1] >= 3;
  if (streak >= 6) {
    finalBreakProb = Math.min(finalBreakProb + 0.15, 0.9);
    reason = `[Bẻ Cầu] Chuỗi ${streak} ${currentResult} dài, khả năng bẻ cầu cao`;
  } else if (streak >= 4 && scoreDeviation > 3) {
    finalBreakProb = Math.min(finalBreakProb + 0.1, 0.85);
    reason = `[Bẻ Cầu] Biến động điểm số lớn (${scoreDeviation.toFixed(1)}), khả năng bẻ cầu tăng`;
  } else if (hasRepeatingPattern && last5Results.every(result => result === currentResult)) {
    finalBreakProb = Math.min(finalBreakProb + 0.05, 0.8);
    reason = `[Bẻ Cầu] Phát hiện mẫu lặp ${mostCommonPattern[0]}, có khả năng bẻ cầu`;
  } else {
    finalBreakProb = Math.max(finalBreakProb - 0.15, 0.15);
    reason = '[Bẻ Cầu] Không phát hiện mẫu bẻ cầu mạnh, tiếp tục theo cầu';
  }
  let prediction = finalBreakProb > 0.65 ? (currentResult === 'Tài' ? 2 : 1) : (currentResult === 'Tài' ? 1 : 2);
  return { prediction, breakProb: finalBreakProb, reason };
}

function trendAndProb(history) {
  if (!history || history.length < 3) return { prediction: 0, reason: "Không đủ dữ liệu" };
  const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
  if (streak >= 5) {
    if (breakProb > 0.75) return { prediction: currentResult === 'Tài' ? 2 : 1, reason: "Bẻ cầu dài" };
    return { prediction: currentResult === 'Tài' ? 1 : 2, reason: "Tiếp tục cầu dài" };
  }
  const last15Results = history.slice(-15).map(item => item.result);
  if (!last15Results.length) return { prediction: 0, reason: "Không đủ dữ liệu" };
  const weightedResults = last15Results.map((result, index) => Math.pow(1.2, index));
  const taiWeight = weightedResults.reduce((sum, weight, i) => sum + (last15Results[i] === 'Tài' ? weight : 0), 0);
  const xiuWeight = weightedResults.reduce((sum, weight, i) => sum + (last15Results[i] === 'Xỉu' ? weight : 0), 0);
  const totalWeight = taiWeight + xiuWeight;
  if (totalWeight > 0 && Math.abs(taiWeight - xiuWeight) / totalWeight >= 0.25) {
    return { prediction: taiWeight > xiuWeight ? 2 : 1, reason: "Theo xu hướng trọng số" };
  }
  return { prediction: last15Results[last15Results.length - 1] === 'Xỉu' ? 1 : 2, reason: "Theo kết quả gần nhất" };
}

function shortPattern(history) {
  if (!history || history.length < 3) return { prediction: 0, reason: "Không đủ dữ liệu" };
  const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
  if (streak >= 4) {
    if (breakProb > 0.75) return { prediction: currentResult === 'Tài' ? 2 : 1, reason: "Bẻ cầu ngắn" };
    return { prediction: currentResult === 'Tài' ? 1 : 2, reason: "Tiếp tục cầu ngắn" };
  }
  const last8Results = history.slice(-8).map(item => item.result);
  if (!last8Results.length) return { prediction: 0, reason: "Không đủ dữ liệu" };
  return { prediction: last8Results[last8Results.length - 1] === 'Xỉu' ? 1 : 2, reason: "Theo kết quả gần nhất" };
}

function meanDeviation(history) {
  if (!history || history.length < 3) return { prediction: 0, reason: "Không đủ dữ liệu" };
  const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
  if (streak >= 4) {
    if (breakProb > 0.75) return { prediction: currentResult === 'Tài' ? 2 : 1, reason: "Bẻ cầu" };
    return { prediction: currentResult === 'Tài' ? 1 : 2, reason: "Tiếp tục cầu" };
  }
  const last12Results = history.slice(-12).map(item => item.result);
  if (!last12Results.length) return { prediction: 0, reason: "Không đủ dữ liệu" };
  const taiCount = last12Results.filter(result => result === 'Tài').length;
  const xiuCount = last12Results.length - taiCount;
  const imbalance = Math.abs(taiCount - xiuCount) / last12Results.length;
  if (imbalance < 0.35) return { prediction: last12Results[last12Results.length - 1] === 'Xỉu' ? 1 : 2, reason: "Cân bằng, tiếp tục cầu" };
  return { prediction: xiuCount > taiCount ? 1 : 2, reason: "Theo bên ít hơn" };
}

function recentSwitch(history) {
  if (!history || history.length < 3) return { prediction: 0, reason: "Không đủ dữ liệu" };
  const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
  if (streak >= 4) {
    if (breakProb > 0.75) return { prediction: currentResult === 'Tài' ? 2 : 1, reason: "Bẻ cầu dài" };
    return { prediction: currentResult === 'Tài' ? 1 : 2, reason: "Tiếp tục cầu dài" };
  }
  const last10Results = history.slice(-10).map(item => item.result);
  if (!last10Results.length) return { prediction: 0, reason: "Không đủ dữ liệu" };
  const switches = last10Results.slice(1).reduce((count, result, index) => count + (result !== last10Results[index] ? 1 : 0), 0);
  return switches >= 6 ? { prediction: last10Results[last10Results.length - 1] === 'Xỉu' ? 1 : 2, reason: "Nhiều biến động, theo bên đối diện" } : { prediction: last10Results[last10Results.length - 1] === 'Xỉu' ? 1 : 2, reason: "Ít biến động, tiếp tục theo cầu" };
}

function aiVanNhatLogic(history) {
  if (!history || history.length < 3) {
    const randomPred = Math.random() < 0.5 ? 'Tài' : 'Xỉu';
    return { prediction: randomPred, reason: 'Không đủ lịch sử, dự đoán ngẫu nhiên', source: 'VANNHAT' };
  }
  const last5Results = history.slice(-5).map(item => item.result);
  const last5Scores = history.slice(-5).map(item => item.score || 0);
  const taiCount = last5Results.filter(result => result === 'Tài').length;
  const xiuCount = last5Results.filter(result => result === 'Xỉu').length;
  if (history.length >= 3) {
    const last3Results = history.slice(-3).map(item => item.result);
    if (last3Results.join(',') === 'Tài,Xỉu,Tài') return { prediction: 'Xỉu', reason: 'Phát hiện mẫu 1T1X → nên đánh Xỉu', source: 'VANNHAT' };
    else if (last3Results.join(',') === 'Xỉu,Tài,Xỉu') return { prediction: 'Tài', reason: 'Phát hiện mẫu 1X1T → nên đánh Tài', source: 'VANNHAT' };
  }
  if (history.length >= 4) {
    const last4Results = history.slice(-4).map(item => item.result);
    if (last4Results.join(',') === 'Tài,Tài,Xỉu,Xỉu') return { prediction: 'Tài', reason: 'Phát hiện mẫu 2T2X → nên đánh Tài', source: 'VANNHAT' };
    else if (last4Results.join(',') === 'Xỉu,Xỉu,Tài,Tài') return { prediction: 'Xỉu', reason: 'Phát hiện mẫu 2X2T → nên đánh Xỉu', source: 'VANNHAT' };
  }
  if (history.length >= 9 && history.slice(-6).every(item => item.result === 'Tài')) return { prediction: 'Xỉu', reason: 'Chuỗi Tài quá dài (6 lần) → dự đoán Xỉu', source: 'VANNHAT' };
  else if (history.length >= 9 && history.slice(-6).every(item => item.result === 'Xỉu')) return { prediction: 'Tài', reason: 'Chuỗi Xỉu quá dài (6 lần) → dự đoán Tài', source: 'VANNHAT' };
  const avgScore = last5Scores.reduce((sum, score) => sum + score, 0) / (last5Scores.length || 1);
  if (avgScore > 10) return { prediction: 'Tài', reason: `Điểm trung bình cao (${avgScore.toFixed(1)}) → dự đoán Tài`, source: 'VANNHAT' };
  else if (avgScore < 8) return { prediction: 'Xỉu', reason: `Điểm trung bình thấp (${avgScore.toFixed(1)}) → dự đoán Xỉu`, source: 'VANNHAT' };
  if (taiCount > xiuCount + 1) return { prediction: 'Xỉu', reason: `Tài chiếm đa số (${taiCount}/${last5Results.length}) → dự đoán Xỉu`, source: 'VANNHAT' };
  else if (xiuCount > taiCount + 1) return { prediction: 'Tài', reason: `Xỉu chiếm đa số (${xiuCount}/${last5Results.length}) → dự đoán Tài`, source: 'VANNHAT' };
  else {
    const totalTai = history.filter(item => item.result === 'Tài').length;
    const totalXiu = history.filter(item => item.result === 'Xỉu').length;
    if (totalTai > totalXiu + 2) return { prediction: 'Xỉu', reason: 'Tổng thể Tài nhiều hơn → dự đoán Xỉu', source: 'VANNHAT' };
    else if (totalXiu > totalTai + 2) return { prediction: 'Tài', reason: 'Tổng thể Xỉu nhiều hơn → dự đoán Tài', source: 'VANNHAT' };
    else {
      const randomPred = Math.random() < 0.5 ? 'Tài' : 'Xỉu';
      return { prediction: randomPred, reason: 'Cân bằng, dự đoán ngẫu nhiên', source: 'VANNHAT' };
    }
  }
}

// [MỚI] Hệ thống quản lý rủi ro
function calculateRiskFactor(history) {
    if (history.length < 20) return 0;
    const last20Results = history.slice(-20).map(item => item.result);
    const switches = last20Results.slice(1).reduce((count, result, index) => count + (result !== last20Results[index] ? 1 : 0), 0);
    const { streak } = detectStreakAndBreak(history);
    
    // Nếu có quá nhiều thay đổi (bệt ngắn) hoặc cầu quá dài, rủi ro cao
    if (switches > 15 || streak > 8) return 1;
    
    // Nếu phân bố Tài/Xỉu quá chênh lệch
    const taiCount = last20Results.filter(r => r === 'Tài').length;
    const xiuCount = last20Results.length - taiCount;
    if (Math.abs(taiCount - xiuCount) > 10) return 0.8;

    return 0; // Rủi ro thấp
}

function generatePrediction(history) {
    if (!history || history.length === 0) {
        return { prediction: Math.random() < 0.5 ? 'Tài' : 'Xỉu', reason: 'Không đủ lịch sử', confidence: 50 };
    }

    updateModelPerformance(history);

    const currentSession = history[history.length - 1].session;
    const models = {
        trend: trendAndProb(history),
        short: shortPattern(history),
        mean: meanDeviation(history),
        switch: recentSwitch(history),
        bridge: smartBridgeBreak(history),
        pattern: patternRecognitionModel(history),
        vannhat: aiVanNhatLogic(history)
    };
    
    // Lưu lại dự đoán của từng mô hình
    for (const key in models) {
        if (!modelPredictions[key]) modelPredictions[key] = {};
        modelPredictions[key][currentSession] = models[key];
    }
    
    const baseWeights = {
        trend: 0.15, short: 0.15, mean: 0.1, switch: 0.1, bridge: 0.15, pattern: 0.2, vannhat: 0.15
    };
    
    let taiScore = 0;
    let xiuScore = 0;

    for (const modelName in baseWeights) {
        const prediction = models[modelName].prediction;
        const weight = baseWeights[modelName] * (modelPerformance[modelName] || 1);
        if (prediction === 1 || prediction === 'Tài') taiScore += weight;
        else if (prediction === 2 || prediction === 'Xỉu') xiuScore += weight;
    }
    
    const finalPrediction = taiScore > xiuScore ? 'Tài' : 'Xỉu';
    const confidence = Math.round(Math.abs(taiScore - xiuScore) / (taiScore + xiuScore) * 100);
    
    const combinedReasons = Object.values(models)
                                  .filter(m => m.reason && m.prediction)
                                  .map(m => m.reason)
                                  .join(' | ');

    const riskFactor = calculateRiskFactor(history);
    const finalConfidence = Math.max(50, confidence + 50 - riskFactor * 50);

    return { 
        prediction: finalPrediction, 
        reason: combinedReasons, 
        confidence: finalConfidence,
        scores: {
            tai: taiScore.toFixed(2),
            xiu: xiuScore.toFixed(2)
        },
        risk_factor: riskFactor.toFixed(2)
    };
}

// ==================== Web Socket và Fastify API ====================
function sendRikCmd1005() {
  if (rikWS?.readyState === WebSocket.OPEN) {
    rikWS.send(JSON.stringify([6, "MiniGame", "taixiuPlugin", { cmd: 1005 }]));
  }
}

function connectRikWebSocket() {
  console.log("🔌 Connecting to SunWin WebSocket...");
  rikWS = new WebSocket(`wss://websocket.azhkthg1.net/websocket?token=${TOKEN}`);
  rikWS.on("open", () => {
    const authPayload = [
      1,
      "MiniGame",
      "SC_apisunwin123",
      "binhlamtool90",
      {
        info: JSON.stringify({
          ipAddress: "2001:ee0:5708:7700:8af3:abd1:fe2a:c62c",
          wsToken: TOKEN,
          userId: "d93d3d84-f069-4b3f-8dac-b4716a812143",
          username: "SC_apisunwin123",
          timestamp: 1753443723662,
          refreshToken: "dd38d05401bb48b4ac3c2f6dc37f36d9.f22dccad89bb4e039814b7de64b05d63",
        }),
        signature: "4FD3165D59BD21DA76B4448EA62E81972BCD54BE0EDBC5291D2415274DA522089BF9318E829A67D07EC78783543D17E75671CBD6FDF60B42B55643F13B66DEB7B0510DE995A8C7C8EDBA4990CE3294C4340D86BF78B02A0E90C6565D1A32EAA894F7384302602CB2703C20981244103E42817257592D42828D6EDB0BB781ADA1",
        pid: 5,
        subi: true
      }
    ];
    rikWS.send(JSON.stringify(authPayload));
    clearInterval(rikIntervalCmd);
    rikIntervalCmd = setInterval(sendRikCmd1005, 5000);
  });

  rikWS.on("message", (data) => {
    try {
      const json = typeof data === 'string' ? JSON.parse(data) : decodeBinaryMessage(data);
      if (!json) return;
      if (Array.isArray(json) && json[3]?.res?.d1) {
        const res = json[3].res;
        if (!rikCurrentSession || res.sid > rikCurrentSession) {
          rikCurrentSession = res.sid;
          rikResults.unshift({ sid: res.sid, d1: res.d1, d2: res.d2, d3: res.d3, timestamp: Date.now() });
          if (rikResults.length > 100) rikResults.pop();
          saveHistory();
          console.log(`📥 Phiên mới ${res.sid} → ${getTX(res.d1, res.d2, res.d3)}`);
          setTimeout(() => { rikWS?.close(); connectRikWebSocket(); }, 1000);
        }
      } else if (Array.isArray(json) && json[1]?.htr) {
        rikResults = json[1].htr.map(i => ({
          sid: i.sid, d1: i.d1, d2: i.d2, d3: i.d3, timestamp: Date.now()
        })).sort((a, b) => b.sid - a.sid).slice(0, 100);
        saveHistory();
        console.log("📦 Đã tải lịch sử các phiên gần nhất.");
      }
    } catch (e) {
      console.error("❌ Parse error:", e.message);
    }
  });

  rikWS.on("close", () => {
    console.log("🔌 WebSocket disconnected. Reconnecting...");
    setTimeout(connectRikWebSocket, 5000);
  });

  rikWS.on("error", (err) => {
    console.error("🔌 WebSocket error:", err.message);
    rikWS.close();
  });
}

// ==================== Khởi tạo ứng dụng và API ====================
loadHistory();
connectRikWebSocket();
fastify.register(cors);

// API Route cho dự đoán Tài Xỉu
fastify.get("/api/taixiu/sunwin", async (request, reply) => {
  const valid = rikResults.filter(r => r.d1 && r.d2 && r.d3).map(i => ({
    session: i.sid,
    dice: [i.d1, i.d2, i.d3],
    total: i.d1 + i.d2 + i.d3,
    result: getTX(i.d1, i.d2, i.d3),
    score: i.d1 + i.d2 + i.d3
  }));
  if (!valid.length) {
    reply.status(404).send({ message: "Không có dữ liệu." });
    return;
  }
  const current = valid[0];
  const phien_sau = current.session + 1;
  const prediction = generatePrediction(valid);
  const formattedDice = `[ ${current.dice[0]} - ${current.dice[1]} - ${current.dice[2]} ]`;
  
  return {
    id: "Tele@CsTool001",
    phien: current.session,
    phien_sau,
    xuc_xac: formattedDice,
    tong: current.total,
    ket_qua: current.result,
    du_doan: prediction.prediction,
    ty_le_thanh_cong: `${prediction.confidence}%`,
    giai_thich: prediction.reason,
    diem_tai: prediction.scores.tai,
    diem_xiu: prediction.scores.xiu,
    muc_do_rui_ro: prediction.risk_factor > 0 ? "CAO" : "THẤP",
  };
});

// API Route cho lịch sử
fastify.get("/api/taixiu/history", async (request, reply) => {
  const valid = rikResults.filter(r => r.d1 && r.d2 && r.d3);
  if (!valid.length) {
    reply.status(404).send({ message: "Không có dữ liệu lịch sử." });
    return;
  }
  const historyData = valid.map(i => ({
    session: i.sid,
    dice: [i.d1, i.d2, i.d3],
    total: i.d1 + i.d2 + i.d3,
    result: getTX(i.d1, i.d2, i.d3)
  }));
  reply.send(historyData);
});

// Khởi động server
const start = async () => {
  try {
    const address = await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`🚀 API chạy tại ${address}`);
  } catch (err) {
    console.error("❌ Server error:", err);
    process.exit(1);
  }
};

start();
