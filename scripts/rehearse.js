// Runs the skill flow end to end on the local node, the way an agent would:
// hongbao.mjs builds the call, fake-baw previews and executes it.
//   npx hardhat node & npx hardhat run scripts/local-setup.js --network localhost
//   node skill/build.mjs localhost && node scripts/rehearse.js
const { execFileSync } = require("child_process");
const path = require("path");
const dep = require("../deployments/localhost.json");

const root = path.join(__dirname, "..");
const A = dep.accounts;
let failures = 0;

function run(file, args) {
  try {
    return JSON.parse(execFileSync("node", [path.join(root, file), ...args], { encoding: "utf8" }));
  } catch (e) {
    return JSON.parse(e.stdout);
  }
}
const hongbao = (...args) => run("skill/agent-redpackets/hongbao.mjs", args);
const splitBaw = (cmd) => cmd.split(" ").slice(1); // drop the leading "baw"

/** Preview and execute every call the helper produced, as the agent would after confirmation. */
function execute(out) {
  const hashes = [];
  for (const c of out.calls) {
    const preview = run("scripts/fake-baw.js", splitBaw(c.baw));
    if (!preview.success) throw new Error(`preview failed: ${JSON.stringify(preview)}`);
    const done = run("scripts/fake-baw.js", ["contract-call", "execute", "--requestId", preview.data.requestId, "--json"]);
    if (done.data?.status !== "BROADCASTED") throw new Error(`execute failed: ${JSON.stringify(done)}`);
    hashes.push(done.data.txHash);
  }
  return hashes;
}

/** The local node mines only on transactions; BNB Chain produces a block every ~0.45 s. */
function nextBlock() {
  execFileSync("curl", ["-s", "-X", "POST", dep.rpc, "-H", "content-type: application/json", "-d", '{"jsonrpc":"2.0","id":1,"method":"evm_mine","params":[]}']);
}

function expectOk(label, out) {
  const ok = out.ok === true;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : "  " + JSON.stringify(out)}`);
  return out;
}
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  -> ${detail}` : ""}`);
}

function expectRefused(label, out, error) {
  const ok = out.ok === false && (!error || out.error === error);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}  -> ${out.reason}`);
}

function main() {
  // 1. alice sends a lucky code packet with the passphrase 恭喜发财
  const created = expectOk("alice builds a code packet", hongbao("create", "--type", "code", "--total", "0.05", "--shares", "3", "--memo", "新年快乐", "--pass", "恭喜发财", "--from", A["alice.ai"]));
  execute(created);
  const share = created.share;
  console.log(`     share text: ${share}`);

  // 2. people grab with the share text
  const withoutPass = share.replace(/ · 口令 .*$/, "");
  expectRefused("bob with the wrong passphrase is refused", hongbao("grab", withoutPass, "--pass", "万事如意", "--from", A["bob.ai"]));
  expectRefused("a wallet without an Agent ID is refused", hongbao("grab", share, "--from", A["(no Agent ID)"]), "NoAgentId");
  execute(expectOk("bob grabs (passphrase said separately)", hongbao("grab", withoutPass, "--pass", "恭喜发财", "--from", A["bob.ai"])));
  const twice = hongbao("grab", share, "--from", A["bob.ai"]);
  expectRefused("bob cannot grab twice", { ...twice, ok: twice.ok === false && /已经抢过/.test(twice.reason) ? false : "unexpected" });
  execute(expectOk("carol grabs", hongbao("grab", share, "--from", A["carol.ai"])));

  const bob = expectOk("bob sees his result", hongbao("result", share, "--from", A["bob.ai"]));
  console.log(`     bob: ${bob.packet.you.status} ${bob.packet.you.amount ?? ""}`);
  let carol = hongbao("result", share, "--from", A["carol.ai"]);
  console.log(`     carol before open: ${carol.packet.you.status}`);
  nextBlock();
  console.log(`     carol one block later: ${hongbao("result", share, "--from", A["carol.ai"]).packet.you.status}`);
  execute(expectOk("carol opens her slot", hongbao("open", created.expectedId, "--from", A["carol.ai"])));
  carol = expectOk("carol sees her result", hongbao("result", share, "--from", A["carol.ai"]));
  console.log(`     carol: ${carol.packet.you.status} ${carol.packet.you.amount}`);
  execute(expectOk("dave takes the last share", hongbao("grab", share, "--from", A["dave.ai"])));
  nextBlock();
  execute(expectOk("dave opens his slot", hongbao("open", created.expectedId, "--from", A["dave.ai"])));
  const fin = expectOk("packet is fully paid", hongbao("inspect", share));
  console.log(`     ${fin.packet.taken}/${fin.packet.shares} taken, remaining ${fin.packet.remaining}`);
  expectRefused("erin finds it full", hongbao("grab", share, "--from", A["erin.ai"]), "Full");

  // 3. direct packet, including a name nobody has registered yet
  const direct = expectOk("bob builds a direct packet", hongbao("create", "--type", "direct", "--to", "dave=0.01,newbie=0.002", "--ttl", "86400", "--from", A["bob.ai"]));
  console.log(`     warning: ${direct.calls[0].warning}`);
  execute(direct);
  const inbox = expectOk("dave finds it in his inbox", hongbao("inbox", "--from", A["dave.ai"]));
  console.log(`     inbox: ${JSON.stringify(inbox.claimable)}`);
  execute(expectOk("dave claims", hongbao("claim", inbox.claimable[0].id, "--from", A["dave.ai"])));
  expectRefused("erin has nothing to claim there", hongbao("claim", inbox.claimable[0].id, "--from", A["erin.ai"]), "NothingToClaim");

  // 4. public equal packet in the mock token (approve exactly, then create)
  const pub = expectOk("carol builds a public token packet", hongbao("create", "--type", "public", "--token", "mUSD", "--total", "10", "--shares", "5", "--equal", "--from", A["carol.ai"]));
  console.log(`     calls: ${pub.calls.map((c) => c.description).join(" | ")}`);
  execute(pub);
  execute(expectOk("erin grabs the public packet", hongbao("grab", `#${pub.expectedId}`, "--from", A["erin.ai"])));
  const heat = expectOk("erin's heat went up", hongbao("heat", "--from", A["erin.ai"]));
  console.log(`     erin heat ${heat.heat}, cools at ${heat.coolsDownAt}`);

  // 5. custom token: any BSC token by address; this one spoofs the symbol "USDT"
  const ct = dep.customToken;
  const cc = expectOk("frank builds a code packet in a custom token", hongbao("create", "--type", "code", "--token", ct, "--total", "50", "--shares", "5", "--equal", "--pass", "大吉大利", "--from", A["frank.ai"]));
  check("the create output warns about the custom token", Boolean(cc.tokenWarning) && cc.tokenWarning.includes(ct), cc.tokenWarning);
  execute(cc);
  const cg = expectOk("alice grabs it", hongbao("grab", cc.share, "--from", A["alice.ai"]));
  check("the packet is reported as a custom token with its address", cg.packet?.customToken === true && cg.packet.tokenAddress === ct, cg.packet?.tokenWarning);
  execute(cg);
  const cr = expectOk("alice sees her custom-token share", hongbao("result", cc.share, "--from", A["alice.ai"]));
  console.log(`     alice: ${cr.packet.you.status} ${cr.packet.you.amount}`);
  expectRefused("a code packet without a passphrase is refused", hongbao("create", "--type", "code", "--token", ct, "--total", "5", "--shares", "5", "--from", A["frank.ai"]));
  expectRefused("an address without code is refused as a token", hongbao("create", "--type", "code", "--token", A["bob.ai"], "--total", "5", "--shares", "5", "--pass", "x", "--from", A["frank.ai"]));

  // 6. junk in the inbox: anyone can address a custom-token direct packet to any name
  execute(expectOk("frank addresses a custom-token direct packet to dave", hongbao("create", "--type", "direct", "--token", ct, "--to", "dave=5", "--from", A["frank.ai"])));
  const box = expectOk("dave's inbox hides it", hongbao("inbox", "--from", A["dave.ai"]));
  check("it reports one hidden custom-token packet", box.hiddenCustomTokenPackets === 1 && box.claimable.every((c) => !c.customToken), JSON.stringify(box.claimable));
  const all = expectOk("dave's inbox --all lists it with the tag", hongbao("inbox", "--from", A["dave.ai"], "--all"));
  const junk = all.claimable.find((c) => c.customToken);
  check("the amount itself carries the custom-token tag and address", Boolean(junk) && junk.amount.includes(ct), junk?.amount);
  expectRefused("claiming it needs --allow-custom", hongbao("claim", junk.id, "--from", A["dave.ai"]));
  execute(expectOk("dave claims it once he accepts that token", hongbao("claim", junk.id, "--from", A["dave.ai"], "--allow-custom")));

  expectRefused("a public packet in a custom token is refused", hongbao("create", "--type", "public", "--token", ct, "--total", "50", "--shares", "5", "--from", A["frank.ai"]));

  if (failures) {
    console.log(`${failures} step(s) failed`);
    process.exit(1);
  }
  console.log("rehearsal passed");
}

main();
