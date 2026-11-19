// Plain-language reasons for AgentHongbao's custom errors, shared by the skill and the web page.
export const REASONS = {
  NoPacket: "没有这个红包",
  WrongKind: "这个红包类型不支持该操作",
  Expired: "红包已过期",
  NotExpired: "红包还没过期，也没领完，暂时不能退款",
  Full: "红包已经被抢完了",
  AlreadyGrabbed: "你已经抢过这个红包了",
  NoAgentId: "这个钱包没有 Agent ID（name.ai），先在 Binance App 里领取",
  BadSignature: "红包码或口令不对",
  NotYetEligible: "你最近抢的公开红包较多，还要再等一会儿才轮到你",
  NothingToClaim: "这里没有发给你的红包，或已经领过",
  NotCreator: "只有发红包的人能退款",
  NotSettled: "还有名额没开奖，先执行开奖再退款",
  NothingToRefund: "没有可退的金额",
  NothingOwed: "没有待提取的金额",
  TokenNotAllowed: "不支持这个代币",
  PublicNeedsListedToken: "公开红包只能用 BNB、USDT、USDC；其他代币请发口令红包或定向红包",
  BadAmount: "金额不对（每份太小、金额与转入不符，或代币收取了手续费）",
  BadShares: "份数需在 1 到 1000 之间",
  BadExpiry: "有效期需在 1 分钟到 365 天之间",
  BadMemo: "祝福语太长",
  BadSigner: "口令红包需要红包码",
  BadHeatStep: "热度等待设置不对",
  BadRecipients: "收件人列表不对（为空、超过 200 个或长度不一致）",
  DuplicateRecipient: "同一个 Agent ID 出现了两次",
  TransferFailed: "转账失败",
  Reentrancy: "调用被拒绝",
  BadConfig: "参数不对",
};

export const REASONS_EN = {
  NoPacket: "No such red packet",
  WrongKind: "This kind of red packet does not support that action",
  Expired: "This red packet has expired",
  NotExpired: "Not expired and not fully claimed yet, so it cannot be refunded",
  Full: "All shares have been taken",
  AlreadyGrabbed: "You have already grabbed this red packet",
  NoAgentId: "This wallet has no Agent ID (name.ai). Claim one in the Binance App first",
  BadSignature: "Wrong share code or passphrase",
  NotYetEligible: "You grabbed many public packets recently; your turn comes a little later",
  NothingToClaim: "Nothing here is addressed to you, or you already claimed it",
  NotCreator: "Only the sender can refund",
  NotSettled: "Some shares are not opened yet. Open them before refunding",
  NothingToRefund: "Nothing to refund",
  NothingOwed: "Nothing to withdraw",
  TokenNotAllowed: "This token is not supported",
  PublicNeedsListedToken: "Public packets take BNB, USDT or USDC only; send other tokens as a code or direct packet",
  BadAmount: "Wrong amount (share too small, value mismatch, or a token that takes a fee)",
  BadShares: "Shares must be between 1 and 1000",
  BadExpiry: "Expiry must be between 1 minute and 365 days",
  BadMemo: "Greeting is too long",
  BadSigner: "A code red packet needs a share code",
  BadHeatStep: "Invalid heat delay",
  BadRecipients: "Invalid recipient list (empty, more than 200, or mismatched lengths)",
  DuplicateRecipient: "The same Agent ID appears twice",
  TransferFailed: "Transfer failed",
  Reentrancy: "Call rejected",
  BadConfig: "Invalid parameters",
};

/** Turns an ethers error from AgentHongbao into { name, reason, args }, or null. */
export function explain(iface, err, lang = "zh") {
  const data = findRevertData(err);
  if (!data) return null;
  try {
    const parsed = iface.parseError(data);
    if (!parsed) return null;
    const en = lang === "en";
    let reason = (en ? REASONS_EN : REASONS)[parsed.name] ?? parsed.name;
    if (parsed.name === "NotYetEligible") {
      const at = new Date(Number(parsed.args[0]) * 1000).toLocaleString(en ? "en-US" : "zh-CN", { hour12: false });
      reason += en ? ` (from ${at})` : `（${at} 后可抢）`;
    }
    return { name: parsed.name, reason, args: [...parsed.args] };
  } catch {
    return null;
  }
}

function findRevertData(err) {
  for (let e = err, i = 0; e && i < 6; e = e.error ?? e.info?.error ?? e.cause, i++) {
    const d = e.data?.data ?? e.data;
    if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) return d;
  }
  return null;
}
