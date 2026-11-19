const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture, mine, time, setCode, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");

const HISTORY = "0x0000F90827F1C53a10cb7A02335B175320002935";
const NATIVE = ethers.ZeroAddress;
const HEAT_PERIOD = 2 * 60 * 60;
const HEAT_MIN = ethers.parseEther("0.001");
const DAY = 24 * 60 * 60;
const E = ethers.parseEther;
const coder = ethers.AbiCoder.defaultAbiCoder();
const hh = (handle) => ethers.keccak256(ethers.toUtf8Bytes(handle));

async function deploy() {
  const signers = await ethers.getSigners();
  const [creator, outsider, ...rest] = signers;
  const holders = rest.slice(0, 14);

  const registry = await (await ethers.getContractFactory("MockRegistry")).deploy();
  const token = await (await ethers.getContractFactory("MockToken")).deploy();
  const hb = await (await ethers.getContractFactory("AgentHongbao")).deploy(
    await registry.getAddress(),
    HEAT_PERIOD,
    [NATIVE, await token.getAddress()],
    [1000n, 1000n],
    [HEAT_MIN, HEAT_MIN]
  );
  const history = await (await ethers.getContractFactory("MockHistory")).deploy();
  await setCode(HISTORY, await ethers.provider.getCode(await history.getAddress()));

  for (let i = 0; i < holders.length; i++) await registry.register(`agent${i}`, holders[i].address);
  await token.mint(creator.address, E("1000"));
  await token.connect(creator).approve(await hb.getAddress(), ethers.MaxUint256);

  return { hb, registry, token, creator, outsider, holders };
}

const expiryIn = async (seconds) => (await time.latest()) + seconds;

async function eventsOf(hb, tx, name) {
  const receipt = await (await tx).wait();
  return receipt.logs
    .filter((l) => l.address === hb.target)
    .map((l) => hb.interface.parseLog(l))
    .filter((e) => e && e.name === name)
    .map((e) => e.args);
}

async function createSplit(hb, creator, o = {}) {
  const total = o.total ?? E("1");
  const token = o.token ?? NATIVE;
  const tx = await hb
    .connect(creator)
    .createSplit(
      token,
      total,
      o.shares ?? 5,
      o.expiry ?? (await expiryIn(o.ttl ?? 30 * DAY)),
      o.isPublic ?? true,
      o.signer ?? ethers.ZeroAddress,
      o.heatStep ?? 0,
      o.lucky ?? true,
      o.memo ?? "gong xi fa cai",
      { value: token === NATIVE ? total : 0n }
    );
  await tx.wait();
  return hb.packetCount();
}

async function signClaim(hb, key, id, who) {
  return key.signMessage(ethers.getBytes(await hb.claimDigest(id, who)));
}

/** Mirror of the contract's draw, used to check which block hash was used. */
function expectedAmount(hash, id, index, who, floor, remaining, left) {
  if (left === 1n) return remaining;
  const spare = remaining - floor * left;
  const seed = BigInt(
    ethers.keccak256(coder.encode(["bytes32", "uint256", "uint256", "address"], [hash, id, index, who]))
  );
  return floor + (seed % ((2n * spare) / left + 1n));
}

describe("AgentHongbao", () => {
  describe("deployment", () => {
    it("fixes the registry, heat period and token list", async () => {
      const { hb, registry, token, outsider } = await loadFixture(deploy);
      expect(await hb.registry()).to.equal(registry.target);
      expect(await hb.heatPeriod()).to.equal(HEAT_PERIOD);
      expect(await hb.packetCount()).to.equal(0);
      expect(await hb.tokenListed(NATIVE)).to.equal(true);
      expect(await hb.tokenListed(token.target)).to.equal(true);
      expect(await hb.tokenAllowed(token.target)).to.equal(true);
      expect(await hb.tokenAllowed(outsider.address)).to.equal(false);
      expect(await hb.heatMinShare(NATIVE)).to.equal(HEAT_MIN);
    });

    it("rejects a registry or token without code, and duplicate tokens", async () => {
      const { registry, token, outsider } = await loadFixture(deploy);
      const F = await ethers.getContractFactory("AgentHongbao");
      const bad = (...a) => expect(F.deploy(...a)).to.be.revertedWithCustomError(F, "BadConfig");
      await bad(outsider.address, 1, [], [], []);
      await bad(registry.target, 1, [outsider.address], [1000], [0]);
      await bad(registry.target, 1, [token.target, token.target], [1000, 1000], [0, 0]);
      await bad(registry.target, 1, [NATIVE, NATIVE], [1000, 1000], [0, 1]); // native set twice
      await bad(registry.target, 1, [token.target], [999], [0]); // below the absolute minimum
      await bad(registry.target, 1, [token.target], [1000], []); // length mismatch
      await bad(registry.target, 0, [], [], []);
    });

    it("has no way to receive plain transfers", async () => {
      const { hb, creator } = await loadFixture(deploy);
      await expect(creator.sendTransaction({ to: hb.target, value: 1n })).to.be.reverted;
    });
  });

  describe("direct packets", () => {
    async function direct(hb, creator, handles, amounts, o = {}) {
      const token = o.token ?? NATIVE;
      const total = amounts.reduce((a, b) => a + b, 0n);
      await hb
        .connect(creator)
        .createDirect(token, handles.map(hh), amounts, o.expiry ?? (await expiryIn(DAY)), "for you", {
          value: o.value ?? (token === NATIVE ? total : 0n),
        });
      return hb.packetCount();
    }

    it("pays the holder of the addressed handle, once", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      const id = await direct(hb, creator, ["agent0", "agent1"], [E("1"), E("2")]);
      await expect(hb.connect(holders[1]).claimDirect(id)).to.changeEtherBalances(
        [holders[1], hb],
        [E("2"), -E("2")]
      );
      await expect(hb.connect(holders[1]).claimDirect(id)).to.be.revertedWithCustomError(hb, "NothingToClaim");
      const p = await hb.getPacket(id);
      expect(p.remaining).to.equal(E("1"));
      expect(p.grabbed).to.equal(1);
    });

    it("refuses holders of other handles and non-holders", async () => {
      const { hb, creator, holders, outsider } = await loadFixture(deploy);
      const id = await direct(hb, creator, ["agent0"], [E("1")]);
      await expect(hb.connect(holders[3]).claimDirect(id)).to.be.revertedWithCustomError(hb, "NothingToClaim");
      await expect(hb.connect(outsider).claimDirect(id)).to.be.revertedWithCustomError(hb, "NoAgentId");
    });

    it("rejects packets addressed to the empty handle, so non-holders can never match", async () => {
      const { hb, creator } = await loadFixture(deploy);
      const exp = await expiryIn(DAY);
      await expect(
        hb.connect(creator).createDirect(NATIVE, [ethers.keccak256("0x")], [1n], exp, "", { value: 1n })
      ).to.be.revertedWithCustomError(hb, "BadRecipients");
      await expect(
        hb.connect(creator).createDirect(NATIVE, [ethers.ZeroHash], [1n], exp, "", { value: 1n })
      ).to.be.revertedWithCustomError(hb, "BadRecipients");
    });

    it("holds a packet for a handle that is registered later", async () => {
      const { hb, registry, creator, outsider } = await loadFixture(deploy);
      const id = await direct(hb, creator, ["latecomer"], [E("1")]);
      await expect(hb.connect(outsider).claimDirect(id)).to.be.revertedWithCustomError(hb, "NoAgentId");
      await registry.register("latecomer", outsider.address);
      await expect(hb.connect(outsider).claimDirect(id)).to.changeEtherBalance(outsider, E("1"));
    });

    it("rejects duplicates, zero amounts, length mismatch and wrong value", async () => {
      const { hb, creator } = await loadFixture(deploy);
      const exp = await expiryIn(DAY);
      const c = hb.connect(creator);
      await expect(
        c.createDirect(NATIVE, [hh("a1"), hh("a1")], [1000n, 1000n], exp, "", { value: 2000n })
      ).to.be.revertedWithCustomError(hb, "DuplicateRecipient");
      await expect(c.createDirect(NATIVE, [hh("a1")], [0n], exp, "", { value: 0n })).to.be.revertedWithCustomError(
        hb,
        "BadAmount"
      );
      await expect(c.createDirect(NATIVE, [hh("a1")], [1n, 2n], exp, "", { value: 3n })).to.be.revertedWithCustomError(
        hb,
        "BadRecipients"
      );
      await expect(c.createDirect(NATIVE, [], [], exp, "", { value: 0n })).to.be.revertedWithCustomError(
        hb,
        "BadRecipients"
      );
      await expect(c.createDirect(NATIVE, [hh("a1")], [5000n], exp, "", { value: 4000n })).to.be.revertedWithCustomError(
        hb,
        "BadAmount"
      );
    });

    it("stops claims at expiry and refunds only the creator, only once", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      const exp = await expiryIn(DAY);
      const id = await direct(hb, creator, ["agent0", "agent1"], [E("1"), E("2")], { expiry: exp });
      await hb.connect(holders[0]).claimDirect(id);
      await expect(hb.connect(creator).refund(id)).to.be.revertedWithCustomError(hb, "NotExpired");
      await time.increaseTo(exp);
      await expect(hb.connect(holders[1]).claimDirect(id)).to.be.revertedWithCustomError(hb, "NothingToClaim");
      await expect(hb.connect(holders[1]).refund(id)).to.be.revertedWithCustomError(hb, "NotCreator");
      await expect(hb.connect(creator).refund(id)).to.changeEtherBalances([creator, hb], [E("2"), -E("2")]);
      await expect(hb.connect(creator).refund(id)).to.be.revertedWithCustomError(hb, "NothingToRefund");
    });

    it("claims several packets at once and skips the ones with nothing", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      const a = await direct(hb, creator, ["agent0"], [E("1")]);
      const b = await direct(hb, creator, ["agent5"], [E("1")]);
      const c = await direct(hb, creator, ["agent0"], [E("3")]);
      await expect(hb.connect(holders[0]).claimDirectMany([a, b, c, 999n])).to.changeEtherBalance(
        holders[0],
        E("4")
      );
      await expect(hb.connect(holders[0]).claimDirectMany([a, b, c])).to.be.revertedWithCustomError(
        hb,
        "NothingToClaim"
      );
    });

    it("works with a listed token and rejects an address without code", async () => {
      const { hb, token, creator, holders } = await loadFixture(deploy);
      const id = await direct(hb, creator, ["agent2"], [E("7")], { token: token.target });
      await expect(hb.connect(holders[2]).claimDirect(id)).to.changeTokenBalances(
        token,
        [holders[2], hb],
        [E("7"), -E("7")]
      );
      await expect(
        hb.connect(creator).createDirect(holders[0].address, [hh("agent2")], [E("1")], await expiryIn(DAY), "")
      ).to.be.revertedWithCustomError(hb, "TokenNotAllowed");
    });

    it("rejects native value sent with a token packet and tokens that take a fee", async () => {
      const { hb, token, creator } = await loadFixture(deploy);
      const exp = await expiryIn(DAY);
      await expect(
        hb.connect(creator).createDirect(token.target, [hh("agent2")], [E("1")], exp, "", { value: 1n })
      ).to.be.revertedWithCustomError(hb, "BadAmount");
      await token.setFee(100);
      await expect(
        hb.connect(creator).createDirect(token.target, [hh("agent2")], [E("1")], exp, "")
      ).to.be.revertedWithCustomError(hb, "BadAmount");
    });
  });

  describe("creating split packets", () => {
    it("validates shares, amount, expiry, memo, signer and heat step", async () => {
      const { hb, creator } = await loadFixture(deploy);
      const c = hb.connect(creator);
      const exp = await expiryIn(DAY);
      const key = ethers.Wallet.createRandom().address;
      const mk = (total, shares, expiry, isPublic, signer, heatStep, memo = "") =>
        c.createSplit(NATIVE, total, shares, expiry, isPublic, signer, heatStep, true, memo, { value: total });

      await expect(mk(E("1"), 0, exp, true, ethers.ZeroAddress, 0)).to.be.revertedWithCustomError(hb, "BadShares");
      await expect(mk(E("1"), 1001, exp, true, ethers.ZeroAddress, 0)).to.be.revertedWithCustomError(hb, "BadShares");
      await expect(mk(999n * 5n, 5, exp, true, ethers.ZeroAddress, 0)).to.be.revertedWithCustomError(hb, "BadAmount");
      await expect(mk(E("1"), 5, (await time.latest()) + 30, true, ethers.ZeroAddress, 0)).to.be.revertedWithCustomError(
        hb,
        "BadExpiry"
      );
      await expect(
        mk(E("1"), 5, (await time.latest()) + 366 * DAY, true, ethers.ZeroAddress, 0)
      ).to.be.revertedWithCustomError(hb, "BadExpiry");
      await expect(mk(E("1"), 5, exp, true, ethers.ZeroAddress, 0, "x".repeat(257))).to.be.revertedWithCustomError(
        hb,
        "BadMemo"
      );
      await expect(mk(E("1"), 5, exp, false, ethers.ZeroAddress, 0)).to.be.revertedWithCustomError(hb, "BadSigner");
      await expect(mk(E("1"), 5, exp, false, key, 60)).to.be.revertedWithCustomError(hb, "BadHeatStep");
      await expect(mk(E("1"), 5, exp, true, ethers.ZeroAddress, 3601)).to.be.revertedWithCustomError(
        hb,
        "BadHeatStep"
      );
      await expect(
        c.createSplit(NATIVE, E("1"), 5, exp, true, ethers.ZeroAddress, 0, true, "", { value: E("0.5") })
      ).to.be.revertedWithCustomError(hb, "BadAmount");
    });

    it("reverts on unknown packets", async () => {
      const { hb, holders } = await loadFixture(deploy);
      await expect(hb.connect(holders[0]).grab(42, "0x")).to.be.revertedWithCustomError(hb, "NoPacket");
      await expect(hb.getPacket(42)).to.be.revertedWithCustomError(hb, "NoPacket");
    });
  });

  describe("code packets (equal split)", () => {
    async function setup() {
      const ctx = await loadFixture(deploy);
      const key = ethers.Wallet.createRandom();
      const id = await createSplit(ctx.hb, ctx.creator, {
        isPublic: false,
        signer: key.address,
        lucky: false,
        shares: 2,
        total: E("1"),
      });
      return { ...ctx, key, id };
    }

    it("pays an equal share at once to a holder with a valid signature", async () => {
      const { hb, holders, key, id } = await setup();
      const sig = await signClaim(hb, key, id, holders[0].address);
      await expect(hb.connect(holders[0]).grab(id, sig)).to.changeEtherBalance(holders[0], E("0.5"));
      expect(await hb.slotOf(id, holders[0].address)).to.equal(1);
    });

    it("rejects a signature made for someone else, a wrong key, or none", async () => {
      const { hb, holders, key, id } = await setup();
      const sig = await signClaim(hb, key, id, holders[0].address);
      await expect(hb.connect(holders[1]).grab(id, sig)).to.be.revertedWithCustomError(hb, "BadSignature");
      const wrong = await signClaim(hb, ethers.Wallet.createRandom(), id, holders[1].address);
      await expect(hb.connect(holders[1]).grab(id, wrong)).to.be.revertedWithCustomError(hb, "BadSignature");
      await expect(hb.connect(holders[1]).grab(id, "0x")).to.be.revertedWithCustomError(hb, "BadSignature");
    });

    it("does not accept a signature for another packet made with the same key", async () => {
      const { hb, creator, holders, key, id } = await setup();
      const id2 = await createSplit(hb, creator, { isPublic: false, signer: key.address, lucky: false });
      const sig = await signClaim(hb, key, id, holders[0].address);
      await expect(hb.connect(holders[0]).grab(id2, sig)).to.be.revertedWithCustomError(hb, "BadSignature");
    });

    it("refuses non-holders, second grabs, full packets and expired packets", async () => {
      const { hb, holders, outsider, key, id } = await setup();
      const sigOf = (s) => signClaim(hb, key, id, s.address);
      await expect(hb.connect(outsider).grab(id, await sigOf(outsider))).to.be.revertedWithCustomError(
        hb,
        "NoAgentId"
      );
      await hb.connect(holders[0]).grab(id, await sigOf(holders[0]));
      await expect(hb.connect(holders[0]).grab(id, await sigOf(holders[0]))).to.be.revertedWithCustomError(
        hb,
        "AlreadyGrabbed"
      );
      await hb.connect(holders[1]).grab(id, await sigOf(holders[1]));
      await expect(hb.connect(holders[2]).grab(id, await sigOf(holders[2]))).to.be.revertedWithCustomError(hb, "Full");
    });

    it("lets the creator refund the unclaimed part after expiry", async () => {
      const { hb, creator, holders, key, id } = await setup();
      await hb.connect(holders[0]).grab(id, await signClaim(hb, key, id, holders[0].address));
      const p = await hb.getPacket(id);
      await time.increaseTo(p.expiry);
      await expect(
        hb.connect(holders[1]).grab(id, await signClaim(hb, key, id, holders[1].address))
      ).to.be.revertedWithCustomError(hb, "Expired");
      await expect(hb.connect(creator).refund(id)).to.changeEtherBalance(creator, E("0.5"));
    });
  });

  describe("lucky packets", () => {
    it("reserves a slot at grab and pays nothing until the block hash exists", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      const id = await createSplit(hb, creator, { shares: 3 });

      await network.provider.send("evm_setAutomine", [false]);
      const grabTx = await hb.connect(holders[0]).grab(id, "0x");
      const openTx = await hb.connect(holders[1]).open(id, 10);
      await network.provider.send("evm_mine");
      await network.provider.send("evm_setAutomine", [true]);

      const r1 = await grabTx.wait();
      const r2 = await openTx.wait();
      expect(r1.blockNumber).to.equal(r2.blockNumber);
      expect((await hb.getPacket(id)).opened).to.equal(0);
      expect((await hb.getPacket(id)).remaining).to.equal(E("1"));
      await mine(1);
      expect(await hb.openable(id)).to.equal(1);

      const [opened] = await eventsOf(hb, hb.connect(holders[5]).open(id, 10), "Opened");
      expect(opened.who).to.equal(holders[0].address);
      expect(opened.floored).to.equal(false);
    });

    it("draws from the hash of the grab block, within floor and twice-the-mean bounds", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      const total = E("1");
      const id = await createSplit(hb, creator, { shares: 4, total });
      const floor = total / 4n / 10n;
      expect((await hb.getPacket(id)).unit).to.equal(floor);

      const grab = await (await hb.connect(holders[0]).grab(id, "0x")).wait();
      const block = await ethers.provider.getBlock(grab.blockNumber);
      const want = expectedAmount(block.hash, id, 0n, holders[0].address, floor, total, 4n);
      await expect(hb.connect(holders[9]).open(id, 1)).to.changeEtherBalance(holders[0], want);
      expect(want).to.be.gte(floor);
      expect(want).to.be.lte(floor + (2n * (total - floor * 4n)) / 4n);
    });

    it("opens earlier slots when the next holder grabs, and gives the last share the rest", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      const total = E("1");
      const id = await createSplit(hb, creator, { shares: 3, total });
      await hb.connect(holders[0]).grab(id, "0x");
      const e1 = await eventsOf(hb, hb.connect(holders[1]).grab(id, "0x"), "Opened");
      expect(e1.map((e) => e.who)).to.deep.equal([holders[0].address]);
      const e2 = await eventsOf(hb, hb.connect(holders[2]).grab(id, "0x"), "Opened");
      expect(e2.map((e) => e.who)).to.deep.equal([holders[1].address]);
      const e3 = await eventsOf(hb, hb.open(id, 10), "Opened");
      expect(e3.map((e) => e.who)).to.deep.equal([holders[2].address]);

      expect(e1[0].amount + e2[0].amount + e3[0].amount).to.equal(total);
      expect((await hb.getPacket(id)).remaining).to.equal(0);
      expect(await ethers.provider.getBalance(hb.target)).to.equal(0);
      await expect(hb.connect(creator).refund(id)).to.be.revertedWithCustomError(hb, "NothingToRefund");
    });

    it("gives the same amounts whoever opens and whenever", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      const id = await createSplit(hb, creator, { shares: 5 });
      // All four grabs in one block, so none of them opens another.
      await network.provider.send("evm_setAutomine", [false]);
      for (let i = 0; i < 4; i++) await hb.connect(holders[i]).grab(id, "0x");
      await network.provider.send("evm_mine");
      await network.provider.send("evm_setAutomine", [true]);
      expect((await hb.getPacket(id)).opened).to.equal(0);
      const amounts = async () => (await hb.queryFilter(hb.filters.Opened(id))).map((e) => e.args.amount);

      const snap = await takeSnapshot();
      await hb.connect(holders[7]).open(id, 10);
      const a = await amounts();
      expect(a.length).to.equal(4);

      await snap.restore();
      await mine(100);
      await hb.connect(holders[8]).open(id, 1);
      await mine(40); // stays within the opcode's reach: the test history contract serves fake hashes
      await hb.connect(creator).open(id, 2);
      await hb.connect(holders[0]).open(id, 10);
      expect(await amounts()).to.deep.equal(a);
    });

    it("handles several grabs in one block", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      const id = await createSplit(hb, creator, { shares: 4 });
      await network.provider.send("evm_setAutomine", [false]);
      const txs = [];
      for (let i = 0; i < 4; i++) txs.push(await hb.connect(holders[i]).grab(id, "0x"));
      await network.provider.send("evm_mine");
      await network.provider.send("evm_setAutomine", [true]);
      const blocks = new Set();
      for (const t of txs) blocks.add((await t.wait()).blockNumber);
      expect(blocks.size).to.equal(1);

      const opened = await eventsOf(hb, hb.open(id, 10), "Opened");
      expect(opened.length).to.equal(4);
      expect(opened.reduce((s, e) => s + e.amount, 0n)).to.equal(E("1"));
      expect(new Set(opened.map((e) => e.amount.toString())).size).to.be.greaterThan(1);
    });

    describe("block hash sources", () => {
      // The open transaction lands `distance` blocks after the grab block.
      async function openAfter(distance) {
        const { hb, creator, holders } = await loadFixture(deploy);
        const total = E("1");
        const id = await createSplit(hb, creator, { shares: 4, total, ttl: 300 * DAY });
        const grab = await (await hb.connect(holders[0]).grab(id, "0x")).wait();
        await mine(distance - 1);
        const tx = hb.connect(holders[1]).open(id, 1);
        const [e] = await eventsOf(hb, tx, "Opened");
        const receipt = await (await tx).wait();
        expect(receipt.blockNumber - grab.blockNumber).to.equal(distance);
        const floor = total / 40n;
        const real = (await ethers.provider.getBlock(grab.blockNumber)).hash;
        const fake = ethers.keccak256(coder.encode(["string", "uint256"], ["history", grab.blockNumber]));
        const amountWith = (h) => expectedAmount(h, id, 0n, holders[0].address, floor, total, 4n);
        return { e, floor, fromOpcode: amountWith(real), fromHistory: amountWith(fake) };
      }

      it("uses the opcode 256 blocks later", async () => {
        const r = await openAfter(256);
        expect(r.e.floored).to.equal(false);
        expect(r.e.amount).to.equal(r.fromOpcode);
      });

      it("uses the history contract 257 blocks later", async () => {
        const r = await openAfter(257);
        expect(r.e.floored).to.equal(false);
        expect(r.e.amount).to.equal(r.fromHistory);
      });

      it("still uses the history contract 8191 blocks later", async () => {
        const r = await openAfter(8191);
        expect(r.e.floored).to.equal(false);
        expect(r.e.amount).to.equal(r.fromHistory);
      });

      it("pays only the floor 8192 blocks later", async () => {
        const r = await openAfter(8192);
        expect(r.e.floored).to.equal(true);
        expect(r.e.amount).to.equal(r.floor);
      });

      it("pays the floor after 256 blocks on a chain without the history contract", async () => {
        const { hb, creator, holders } = await loadFixture(deploy);
        await setCode(HISTORY, "0x");
        const id = await createSplit(hb, creator, { shares: 4, ttl: 300 * DAY });
        await hb.connect(holders[0]).grab(id, "0x");
        await mine(256);
        const [e] = await eventsOf(hb, hb.open(id, 1), "Opened");
        expect(e.floored).to.equal(true);
      });
    });

    it("floors a stale last share and leaves the rest for the creator", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      const total = E("1");
      const id = await createSplit(hb, creator, { shares: 1, total, ttl: 300 * DAY });
      await hb.connect(holders[0]).grab(id, "0x");
      await mine(8192);
      const [e] = await eventsOf(hb, hb.open(id, 1), "Opened");
      expect(e.amount).to.equal(total / 10n);
      await expect(hb.connect(creator).refund(id)).to.changeEtherBalance(creator, total - total / 10n);
    });

    it("requires pending slots to be opened before a refund", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      const total = E("1");
      const id = await createSplit(hb, creator, { shares: 5, total, ttl: 600 });
      await hb.connect(holders[0]).grab(id, "0x");
      await hb.connect(holders[1]).grab(id, "0x");
      await expect(hb.connect(creator).refund(id)).to.be.revertedWithCustomError(hb, "NotExpired");
      await time.increaseTo((await hb.getPacket(id)).expiry);
      await expect(hb.connect(creator).refund(id)).to.be.revertedWithCustomError(hb, "NotSettled");

      const paid = (await hb.queryFilter(hb.filters.Opened(id))).reduce((s, e) => s + e.args.amount, 0n);
      const [last] = await eventsOf(hb, hb.open(id, 10), "Opened");
      await expect(hb.connect(creator).refund(id)).to.changeEtherBalance(creator, total - paid - last.amount);
      expect(await ethers.provider.getBalance(hb.target)).to.equal(0);
    });

    it("lets the creator refund a full, settled packet early when floors left something", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      const id = await createSplit(hb, creator, { shares: 2, ttl: 300 * DAY });
      await hb.connect(holders[0]).grab(id, "0x");
      await hb.connect(holders[1]).grab(id, "0x");
      await mine(8192);
      await hb.open(id, 10);
      const p = await hb.getPacket(id);
      expect(p.opened).to.equal(2);
      expect(p.remaining + p.forfeited).to.be.greaterThan(0);
      await expect(hb.connect(creator).refund(id)).to.changeEtherBalance(creator, p.remaining + p.forfeited);
    });

    it("works with tokens", async () => {
      const { hb, token, creator, holders } = await loadFixture(deploy);
      const total = E("30");
      const id = await createSplit(hb, creator, { shares: 3, total, token: token.target });
      for (let i = 0; i < 3; i++) await hb.connect(holders[i]).grab(id, "0x");
      await hb.open(id, 10);
      let sum = 0n;
      for (let i = 0; i < 3; i++) sum += await token.balanceOf(holders[i].address);
      expect(sum).to.equal(total);
      expect(await token.balanceOf(hb.target)).to.equal(0);
    });
  });

  describe("recipients that cannot be paid", () => {
    async function setup() {
      const ctx = await loadFixture(deploy);
      const stubborn = await (await ethers.getContractFactory("StubbornHolder")).deploy(ctx.hb.target);
      await ctx.registry.register("stubborn", stubborn.target);
      return { ...ctx, stubborn };
    }

    it("credits the amount and keeps the queue moving", async () => {
      const { hb, creator, holders, stubborn, outsider } = await setup();
      const total = E("1");
      const id = await createSplit(hb, creator, { shares: 3, total });
      await stubborn.grab(id);
      await hb.connect(holders[0]).grab(id, "0x");
      await hb.connect(holders[1]).grab(id, "0x");
      const opened = await eventsOf(hb, hb.open(id, 10), "Opened");
      const all = await hb.queryFilter(hb.filters.Opened(id));
      expect(all.length).to.equal(3);
      const mine_ = all.find((e) => e.args.who === stubborn.target).args.amount;
      expect(await hb.owed(stubborn.target, NATIVE)).to.equal(mine_);
      expect(await ethers.provider.getBalance(hb.target)).to.equal(mine_);
      expect(opened.length).to.be.greaterThan(0);

      await expect(stubborn.withdraw(NATIVE, stubborn.target)).to.be.revertedWithCustomError(hb, "TransferFailed");
      await expect(stubborn.withdraw(NATIVE, outsider.address)).to.changeEtherBalance(outsider, mine_);
      await expect(stubborn.withdraw(NATIVE, outsider.address)).to.be.revertedWithCustomError(hb, "NothingOwed");
      expect(await ethers.provider.getBalance(hb.target)).to.equal(0);
    });

    it("cannot be re-entered while paying", async () => {
      const { hb, creator, holders, stubborn } = await setup();
      const id = await createSplit(hb, creator, { shares: 3 });
      await stubborn.setAccept(true);
      await stubborn.setReenter(id);
      await stubborn.grab(id);
      await hb.connect(holders[0]).grab(id, "0x");
      await hb.open(id, 10);
      expect(await stubborn.reentered()).to.equal(true);
      expect(await stubborn.reenterOk()).to.equal(false);
      expect((await hb.getPacket(id)).opened).to.equal(2);
    });

    it("credits a token payout the token refuses", async () => {
      const { hb, token, creator, holders } = await loadFixture(deploy);
      const id = await createSplit(hb, creator, { shares: 2, total: E("10"), token: token.target, lucky: false });
      await token.setBlocked(holders[0].address, true);
      await hb.connect(holders[0]).grab(id, "0x");
      expect(await hb.owed(holders[0].address, token.target)).to.equal(E("5"));
      await hb.connect(holders[1]).grab(id, "0x");
      expect(await token.balanceOf(holders[1].address)).to.equal(E("5"));
      await expect(hb.connect(holders[0]).withdraw(token.target, holders[0].address)).to.be.revertedWithCustomError(
        hb,
        "TransferFailed"
      );
      await hb.connect(holders[0]).withdraw(token.target, holders[3].address);
      expect(await token.balanceOf(holders[3].address)).to.equal(E("5"));
    });
  });

  describe("public packets and heat", () => {
    const pub = (hb, creator, o = {}) =>
      createSplit(hb, creator, { lucky: false, shares: 10, total: E("1"), heatStep: 120, ttl: DAY, ...o });

    it("lets a holder with no heat grab at once and adds one point per grab", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      const a = await pub(hb, creator);
      expect(await hb.heatOf(holders[0].address)).to.equal(0);
      await hb.connect(holders[0]).grab(a, "0x");
      expect(await hb.heatOf(holders[0].address)).to.equal(1);
      const b = await pub(hb, creator);
      const createdAt = (await hb.getPacket(b)).createdAt;
      expect(await hb.eligibleAt(b, holders[0].address)).to.equal(createdAt + 120n);
      expect(await hb.eligibleAt(b, holders[1].address)).to.equal(createdAt);
    });

    it("makes a hot holder wait, without ever excluding them", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      for (let i = 0; i < 3; i++) await hb.connect(holders[0]).grab(await pub(hb, creator, { heatStep: 0 }), "0x");
      expect(await hb.heatOf(holders[0].address)).to.equal(3);

      const id = await pub(hb, creator);
      const at = await hb.eligibleAt(id, holders[0].address);
      expect(at).to.equal((await hb.getPacket(id)).createdAt + 360n);
      await expect(hb.connect(holders[0]).grab(id, "0x"))
        .to.be.revertedWithCustomError(hb, "NotYetEligible")
        .withArgs(at);
      await hb.connect(holders[1]).grab(id, "0x"); // no heat: goes first
      await time.increaseTo(at);
      await hb.connect(holders[0]).grab(id, "0x");
    });

    it("caps the wait at half the packet's lifetime", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      for (let i = 0; i < 8; i++) await hb.connect(holders[0]).grab(await pub(hb, creator, { heatStep: 0 }), "0x");
      const id = await pub(hb, creator, { heatStep: 3600, ttl: 3600 });
      const p = await hb.getPacket(id);
      expect(await hb.eligibleAt(id, holders[0].address)).to.equal(p.createdAt + (p.expiry - p.createdAt) / 2n);
    });

    it("wears off one point per heat period", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      for (let i = 0; i < 3; i++) await hb.connect(holders[0]).grab(await pub(hb, creator, { heatStep: 0 }), "0x");
      const until = await hb.heatUntil(holders[0].address);
      await time.increaseTo(until - BigInt(2 * HEAT_PERIOD));
      expect(await hb.heatOf(holders[0].address)).to.equal(2);
      await time.increaseTo(until - 1n);
      expect(await hb.heatOf(holders[0].address)).to.equal(1);
      await time.increaseTo(until);
      expect(await hb.heatOf(holders[0].address)).to.equal(0);
    });

    it("cools the creator by one point for each share someone else takes", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      const giver = holders[0];
      for (let i = 0; i < 3; i++) await hb.connect(giver).grab(await pub(hb, creator, { heatStep: 0 }), "0x");
      expect(await hb.heatOf(giver.address)).to.equal(3);

      const id = await pub(hb, giver, { heatStep: 0 });
      await hb.connect(giver).grab(id, "0x"); // own packet: heats, does not cool
      expect(await hb.heatOf(giver.address)).to.equal(4);
      await hb.connect(holders[1]).grab(id, "0x");
      await hb.connect(holders[2]).grab(id, "0x");
      expect(await hb.heatOf(giver.address)).to.equal(2);
      expect(await hb.heatOf(holders[1].address)).to.equal(1);
    });

    it("does not move heat for packets below the minimum average share", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      const giver = holders[0];
      await hb.connect(giver).grab(await pub(hb, creator, { heatStep: 0 }), "0x");
      const dust = await pub(hb, giver, { total: HEAT_MIN * 10n - 10n });
      expect((await hb.getPacket(dust)).heatCounts).to.equal(false);
      await hb.connect(holders[1]).grab(dust, "0x");
      expect(await hb.heatOf(holders[1].address)).to.equal(0);
      expect(await hb.heatOf(giver.address)).to.equal(1);
      const enough = await pub(hb, giver, { total: HEAT_MIN * 10n });
      expect((await hb.getPacket(enough)).heatCounts).to.equal(true);
    });

    it("leaves heat alone for code packets", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      const key = ethers.Wallet.createRandom();
      const id = await createSplit(hb, creator, { isPublic: false, signer: key.address, lucky: false });
      await hb.connect(holders[0]).grab(id, await signClaim(hb, key, id, holders[0].address));
      expect(await hb.heatOf(holders[0].address)).to.equal(0);
      expect((await hb.getPacket(id)).heatCounts).to.equal(false);
    });

    it("checks the passphrase key on a public packet that has one", async () => {
      const { hb, creator, holders } = await loadFixture(deploy);
      const key = ethers.Wallet.createRandom();
      const id = await pub(hb, creator, { signer: key.address });
      await expect(hb.connect(holders[0]).grab(id, "0x")).to.be.revertedWithCustomError(hb, "BadSignature");
      await hb.connect(holders[0]).grab(id, await signClaim(hb, key, id, holders[0].address));
      expect(await hb.heatOf(holders[0].address)).to.equal(1);
    });
  });

  describe("conservation", () => {
    // Small deterministic generator so failures can be replayed.
    function rng(seed) {
      let s = seed >>> 0;
      return (n) => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s % n;
      };
    }

    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      it(`pays out and refunds exactly what was put in (seed ${seed})`, async () => {
        const { hb, registry, creator, holders } = await loadFixture(deploy);
        const stubborn = await (await ethers.getContractFactory("StubbornHolder")).deploy(hb.target);
        await registry.register("stubborn", stubborn.target);
        const rand = rng(seed);

        const packets = [];
        for (let k = 0; k < 4; k++) {
          const shares = 1 + rand(9);
          const total = BigInt(shares) * (1000n + BigInt(rand(1_000_000))) * 10n ** BigInt(rand(13)) + BigInt(rand(shares));
          const lucky = rand(4) !== 0;
          const id = await createSplit(hb, creator, { shares, total, lucky, ttl: 2 * DAY });
          packets.push({ id, shares, total, lucky, takers: new Set() });
        }

        for (let step = 0; step < 40; step++) {
          const p = packets[rand(packets.length)];
          const action = rand(10);
          if (action < 5) {
            const i = rand(holders.length + 1);
            const key = i === holders.length ? "stubborn" : i;
            if (p.takers.has(key) || p.takers.size >= p.shares) continue;
            p.takers.add(key);
            if (key === "stubborn") await stubborn.grab(p.id);
            else await hb.connect(holders[i]).grab(p.id, "0x");
          } else if (action < 7) {
            await hb.open(p.id, 1 + rand(3));
          } else if (action < 9) {
            await mine(1 + rand(300));
          } else if (rand(3) === 0) {
            await mine(8192); // some slots age out and get the floor
          }
        }

        await time.increase(3 * DAY);
        let expectedOwed = 0n;
        for (const p of packets) {
          await hb.open(p.id, 1000);
          const state = await hb.getPacket(p.id);
          expect(state.opened).to.equal(state.grabbed);
          const opened = (await hb.queryFilter(hb.filters.Opened(p.id))).map((e) => e.args);
          expect(opened.length).to.equal(p.takers.size);
          const paid = opened.reduce((s, e) => s + e.amount, 0n);
          for (const e of opened) {
            expect(e.amount).to.be.gte(state.unit);
            if (e.who === stubborn.target) expectedOwed += e.amount;
          }
          const back = state.remaining + state.forfeited;
          expect(paid + back).to.equal(p.total);
          if (back > 0n) {
            await expect(hb.connect(creator).refund(p.id)).to.changeEtherBalance(creator, back);
          }
          const after = await hb.getPacket(p.id);
          expect(after.remaining + after.forfeited).to.equal(0);
        }
        expect(await hb.owed(stubborn.target, NATIVE)).to.equal(expectedOwed);
        expect(await ethers.provider.getBalance(hb.target)).to.equal(expectedOwed);
      });
    }
  });
});

describe("review fixes", () => {
  it("returns the expected share of aged-out slots to the creator, not to the last grabber", async () => {
    const { hb, creator, holders } = await loadFixture(deploy);
    const total = E("10");
    const id = await createSplit(hb, creator, { shares: 10, total, ttl: 300 * DAY });
    // Nine grabs in one block, so none of them opens another; then nobody opens for too long.
    await network.provider.send("evm_setAutomine", [false]);
    for (let i = 0; i < 9; i++) await hb.connect(holders[i]).grab(id, "0x");
    await network.provider.send("evm_mine");
    await network.provider.send("evm_setAutomine", [true]);
    await mine(8192);
    await hb.open(id, 20);
    let p = await hb.getPacket(id);
    expect(p.opened).to.equal(9);
    // Exactly one mean share is left for the last slot; the other 8.1 waits for the creator.
    expect(p.remaining).to.equal(total / 10n);
    expect(p.forfeited).to.equal(total - total / 100n * 9n - total / 10n);

    await hb.connect(holders[9]).grab(id, "0x");
    const [last] = await eventsOf(hb, hb.open(id, 1), "Opened");
    expect(last.amount).to.equal(total / 10n);
    p = await hb.getPacket(id);
    await expect(hb.connect(creator).refund(id)).to.changeEtherBalance(creator, p.forfeited);
    expect(await ethers.provider.getBalance(hb.target)).to.equal(0);
  });

  it("keeps the mean for the remaining slots when one slot ages out", async () => {
    const { hb, creator, holders } = await loadFixture(deploy);
    const total = E("4");
    const id = await createSplit(hb, creator, { shares: 4, total, ttl: 300 * DAY });
    await hb.connect(holders[0]).grab(id, "0x");
    await mine(8192);
    await hb.open(id, 1);
    const p = await hb.getPacket(id);
    expect(p.remaining).to.equal(E("3")); // three shares left, mean still 1
    expect(p.forfeited).to.equal(E("1") - E("0.1"));
  });

  it("lets a grab succeed with tight gas by opening fewer predecessors", async () => {
    const { hb, token, creator, holders } = await loadFixture(deploy);
    const id = await createSplit(hb, creator, { shares: 6, total: E("6"), token: token.target, ttl: 300 * DAY });
    await network.provider.send("evm_setAutomine", [false]);
    for (let i = 0; i < 3; i++) await hb.connect(holders[i]).grab(id, "0x");
    await network.provider.send("evm_mine");
    await network.provider.send("evm_setAutomine", [true]);

    // What a wallet would estimate if nothing were openable yet: a grab in a fresh packet.
    const probe = await createSplit(hb, creator, { shares: 6, total: E("6"), token: token.target, ttl: 300 * DAY });
    const alone = await hb.connect(holders[3]).grab.estimateGas(probe, "0x");

    const tx = await hb.connect(holders[3]).grab(id, "0x", { gasLimit: alone + 20_000n });
    const receipt = await tx.wait();
    expect(receipt.status).to.equal(1);
    expect((await hb.getPacket(id)).opened).to.be.lessThan(3);

    // With room to spare it opens all three.
    const id2 = await createSplit(hb, creator, { shares: 6, total: E("6"), token: token.target, ttl: 300 * DAY });
    await network.provider.send("evm_setAutomine", [false]);
    for (let i = 0; i < 3; i++) await hb.connect(holders[i]).grab(id2, "0x");
    await network.provider.send("evm_mine");
    await network.provider.send("evm_setAutomine", [true]);
    await hb.connect(holders[3]).grab(id2, "0x", { gasLimit: 1_000_000 });
    expect((await hb.getPacket(id2)).opened).to.equal(3);
  });

  it("always opens at least one slot when open() is called, even with little gas", async () => {
    const { hb, creator, holders } = await loadFixture(deploy);
    const id = await createSplit(hb, creator, { shares: 3, ttl: 300 * DAY });
    await network.provider.send("evm_setAutomine", [false]);
    for (let i = 0; i < 2; i++) await hb.connect(holders[i]).grab(id, "0x");
    await network.provider.send("evm_mine");
    await network.provider.send("evm_setAutomine", [true]);
    const gas = await hb.open.estimateGas(id, 10);
    await hb.open(id, 10, { gasLimit: gas });
    expect((await hb.getPacket(id)).opened).to.be.greaterThan(0);
  });

  it("enforces the per-token minimum share", async () => {
    const { registry, token, creator } = await loadFixture(deploy);
    const F = await ethers.getContractFactory("AgentHongbao");
    const hb2 = await F.deploy(registry.target, HEAT_PERIOD, [NATIVE, token.target], [E("0.001"), E("0.01")], [0, 0]);
    expect(await hb2.minShare(NATIVE)).to.equal(E("0.001"));
    const exp = await expiryIn(DAY);
    const c = hb2.connect(creator);
    await expect(
      c.createSplit(NATIVE, E("0.0049"), 5, exp, true, ethers.ZeroAddress, 0, true, "", { value: E("0.0049") })
    ).to.be.revertedWithCustomError(hb2, "BadAmount");
    await c.createSplit(NATIVE, E("0.005"), 5, exp, true, ethers.ZeroAddress, 0, true, "", { value: E("0.005") });
    await expect(
      c.createDirect(NATIVE, [hh("agent0")], [E("0.0009")], exp, "", { value: E("0.0009") })
    ).to.be.revertedWithCustomError(hb2, "BadAmount");
    // A token without its own entry still has the absolute minimum.
    const hb3 = await F.deploy(registry.target, HEAT_PERIOD, [token.target], [E("0.01")], [0]);
    expect(await hb3.minShare(NATIVE)).to.equal(1000n);
  });
});

describe("custom tokens", () => {
  const Mode = { Honest: 0, Revert: 1, ReturnFalse: 2, BurnGas: 3, Reenter: 4, NoReturn: 5, HugeReturn: 6 };

  // Unlisted tokens fund code (and direct) packets only; these tests grab with one claim key.
  const key = new ethers.Wallet(ethers.id("custom-token claim key"));
  const codeSplit = (hb, creator, o) => createSplit(hb, creator, { isPublic: false, signer: key.address, ...o });
  const grabCode = async (hb, who, id, overrides = {}) => hb.connect(who).grab(id, await signClaim(hb, key, id, who.address), overrides);

  async function withHostile() {
    const ctx = await loadFixture(deploy);
    const bad = await (await ethers.getContractFactory("HostileToken")).deploy();
    await bad.mint(ctx.creator.address, 10n ** 12n);
    await bad.connect(ctx.creator).approve(ctx.hb.target, ethers.MaxUint256);
    return { ...ctx, bad };
  }

  it("accepts any token contract with the absolute minimum, and pays it out", async () => {
    const { hb, creator, holders } = await loadFixture(deploy);
    const other = await (await ethers.getContractFactory("MockToken")).deploy();
    await other.mint(creator.address, E("10"));
    await other.connect(creator).approve(hb.target, ethers.MaxUint256);
    expect(await hb.tokenListed(other.target)).to.equal(false);
    expect(await hb.tokenAllowed(other.target)).to.equal(true);
    expect(await hb.minShareOf(other.target)).to.equal(1000n);
    const exp = await expiryIn(DAY);
    await expect(
      hb.connect(creator).createSplit(other.target, 4999n, 5, exp, true, ethers.ZeroAddress, 0, false, "")
    ).to.be.revertedWithCustomError(hb, "BadAmount");
    const id = await codeSplit(hb, creator, { token: other.target, total: E("5"), shares: 5, lucky: false });
    await expect(grabCode(hb, holders[0], id)).to.changeTokenBalances(other, [holders[0], hb], [E("1"), -E("1")]);
  });

  it("refuses a public packet in an unlisted token, but not a code or direct one", async () => {
    const { hb, creator, holders, token } = await loadFixture(deploy);
    const other = await (await ethers.getContractFactory("MockToken")).deploy();
    await other.mint(creator.address, E("1000"));
    await other.connect(creator).approve(hb.target, ethers.MaxUint256);
    await expect(createSplit(hb, creator, { token: other.target, total: E("10"), shares: 2 })).to.be.revertedWithCustomError(hb, "PublicNeedsListedToken");
    await codeSplit(hb, creator, { token: other.target, total: E("10"), shares: 2 });
    await hb.connect(creator).createDirect(other.target, [hh("agent0")], [E("1")], await expiryIn(DAY), "");
    // Listed tokens still fund public packets, and those move heat.
    const id = await createSplit(hb, creator, { token: token.target, total: E("10"), shares: 2, lucky: false });
    expect((await hb.getPacket(id)).heatCounts).to.equal(true);
    await hb.connect(holders[0]).grab(id, "0x");
    expect(await hb.heatOf(holders[0].address)).to.equal(1);
  });

  it("refuses an unlisted fee-on-transfer token", async () => {
    const { hb, creator } = await loadFixture(deploy);
    const other = await (await ethers.getContractFactory("MockToken")).deploy();
    await other.mint(creator.address, E("10"));
    await other.connect(creator).approve(hb.target, ethers.MaxUint256);
    await other.setFee(100);
    await expect(codeSplit(hb, creator, { token: other.target, total: E("1") })).to.be.revertedWithCustomError(hb, "BadAmount");
  });

  it("works with a token whose transfer returns nothing", async () => {
    const { hb, creator, holders, bad } = await withHostile();
    await bad.setMode(Mode.NoReturn);
    const id = await codeSplit(hb, creator, { token: bad.target, total: 5_000_000n, lucky: false });
    await grabCode(hb, holders[0], id);
    expect(await bad.balanceOf(holders[0].address)).to.equal(1_000_000n);
    expect(await hb.owed(holders[0].address, bad.target)).to.equal(0);
  });

  for (const [name, mode] of [["reverts", "Revert"], ["returns false", "ReturnFalse"], ["returns huge data", "HugeReturn"]]) {
    it(`credits the payout when the token's transfer ${name}, without blocking the grab`, async () => {
      const { hb, creator, holders, bad } = await withHostile();
      const id = await codeSplit(hb, creator, { token: bad.target, total: 5_000_000n, lucky: false });
      await bad.setMode(Mode[mode]);
      await grabCode(hb, holders[0], id);
      const credited = mode === "HugeReturn" ? 0n : 1_000_000n; // huge but well-formed "true" is a success
      expect(await hb.owed(holders[0].address, bad.target)).to.equal(credited);
      expect((await hb.getPacket(id)).remaining).to.equal(4_000_000n);
    });
  }

  it("caps the gas a token can burn on a payout, and keeps lucky slots opening", async () => {
    const { hb, creator, holders, bad } = await withHostile();
    const id = await codeSplit(hb, creator, { token: bad.target, total: 5_000_000n, shares: 3, lucky: true });
    await bad.setMode(Mode.BurnGas);
    await grabCode(hb, holders[0], id);
    await mine(1);
    const tx = await grabCode(hb, holders[1], id); // opens slot 0 on its way
    const receipt = await tx.wait();
    expect(receipt.gasUsed).to.be.lessThan(400_000n);
    expect((await hb.getPacket(id)).opened).to.equal(1);
    expect(await hb.owed(holders[0].address, bad.target)).to.be.greaterThan(0);
    // The holder takes it later with full gas once the token behaves.
    await bad.setMode(Mode.Honest);
    const owed = await hb.owed(holders[0].address, bad.target);
    await hb.connect(holders[0]).withdraw(bad.target, holders[0].address);
    expect(await bad.balanceOf(holders[0].address)).to.equal(owed);
  });

  it("never runs out of gas opening slots of a gas-burning token, whatever the gas limit", async () => {
    const { hb, creator, holders, bad } = await withHostile();
    const id = await codeSplit(hb, creator, { token: bad.target, total: 5_000_000n, shares: 5, lucky: true });
    await bad.setMode(Mode.BurnGas);
    await network.provider.send("evm_setAutomine", [false]);
    for (let i = 0; i < 4; i++) await grabCode(hb, holders[i], id, { gasLimit: 400_000 });
    await network.provider.send("evm_mine");
    await network.provider.send("evm_setAutomine", [true]);
    const fails = [];
    const base = await takeSnapshot();
    let first = null;
    for (let g = 60_000; g <= 800_000; g += 2_000) {
      let ok;
      try {
        ok = (await (await hb.open(id, 10, { gasLimit: g })).wait()).status === 1;
      } catch {
        ok = false;
      }
      if (ok && first === null) first = g;
      if (!ok && first !== null) fails.push(g); // reverted although a smaller limit had worked
      await base.restore();
    }
    expect(fails, `reverted at gas limits ${fails.join(",")}`).to.deep.equal([]);
  });

  it("names the token in DirectAdded, and claims hostile and honest direct packets together", async () => {
    const { hb, creator, holders, bad, token } = await withHostile();
    const exp = await expiryIn(DAY);
    const tx = hb.connect(creator).createDirect(bad.target, [hh("agent0")], [1_000_000n], exp, "");
    const [added] = await eventsOf(hb, tx, "DirectAdded");
    expect(added.token).to.equal(bad.target);
    const evil = await hb.packetCount();
    await hb.connect(creator).createDirect(token.target, [hh("agent0")], [E("2")], exp, "");
    const good = await hb.packetCount();
    await bad.setMode(Mode.BurnGas);
    await hb.connect(holders[0]).claimDirectMany([evil, good]);
    expect(await token.balanceOf(holders[0].address)).to.equal(E("2"));
    expect(await hb.owed(holders[0].address, bad.target)).to.equal(1_000_000n);
  });

  it("does not let a token re-enter while it is paid", async () => {
    const { hb, creator, holders, bad } = await withHostile();
    const id = await codeSplit(hb, creator, { token: bad.target, total: 5_000_000n, shares: 5, lucky: false, ttl: DAY });
    await bad.setTarget(hb.target, id);
    await bad.setMode(Mode.Reenter);
    await grabCode(hb, holders[0], id);
    expect(await bad.reenterFailed()).to.equal(true);
    expect(await bad.balanceOf(holders[0].address)).to.equal(1_000_000n);
    expect((await hb.getPacket(id)).remaining).to.equal(4_000_000n);
  });

  it("keeps each token's packets apart: a hostile token cannot touch BNB or USDT packets", async () => {
    const { hb, creator, holders, bad, token } = await withHostile();
    const good = await createSplit(hb, creator, { token: token.target, total: E("5"), lucky: false });
    const native = await createSplit(hb, creator, { total: E("1"), lucky: false });
    const evil = await codeSplit(hb, creator, { token: bad.target, total: 5_000_000n, lucky: false });
    await bad.setMode(Mode.Revert);
    await grabCode(hb, holders[0], evil);
    await expect(hb.connect(holders[0]).grab(good, "0x")).to.changeTokenBalance(token, holders[0], E("1"));
    await expect(hb.connect(holders[0]).grab(native, "0x")).to.changeEtherBalance(holders[0], E("0.2"));
  });
});

describe("off-chain claim helpers", () => {
  const claim = require("../lib/claim.mjs");

  it("derives a key the contract accepts, bound to the caller", async () => {
    const { hb, creator, holders } = await loadFixture(deploy);
    const code = claim.newCode();
    const key = claim.claimKey(code, "恭喜发财");
    const id = await createSplit(hb, creator, { isPublic: false, signer: key.address, lucky: false });
    const { chainId } = await ethers.provider.getNetwork();
    expect(claim.claimDigest(chainId, hb.target, id, holders[0].address)).to.equal(
      await hb.claimDigest(id, holders[0].address)
    );
    const sig = await claim.signGrab(claim.claimKey(code.toLowerCase(), " 恭喜发财 "), chainId, hb.target, id, holders[0].address);
    await expect(hb.connect(holders[1]).grab(id, sig)).to.be.revertedWithCustomError(hb, "BadSignature");
    await hb.connect(holders[0]).grab(id, sig);
  });

  it("gives different keys for different codes or passphrases, and rejects malformed codes", () => {
    const code = claim.newCode();
    expect(code).to.match(/^([0-9A-HJKMNP-TV-Z]{4}-){3}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(claim.claimKey(code, "a").address).to.not.equal(claim.claimKey(code, "b").address);
    expect(claim.claimKey(code, "a").address).to.not.equal(claim.claimKey(claim.newCode(), "a").address);
    expect(() => claim.claimKey("short", "a")).to.throw();
    expect(() => claim.claimKey(null, "")).to.throw();
    expect(claim.handleHash("Alice.ai")).to.equal(ethers.keccak256(ethers.toUtf8Bytes("alice")));
  });
});

describe("share text and invite", () => {
  const share = require("../lib/share.mjs");
  const claim = require("../lib/claim.mjs");

  it("round-trips Chinese and English share lines", () => {
    const code = claim.newCode();
    for (const lang of ["zh", "en"]) {
      const line = share.formatShare({ id: 12n, code, passphrase: "恭喜发财", memo: "hi", lang });
      const parsed = share.parseShare(line);
      expect(parsed.id).to.equal(12n);
      expect(parsed.code).to.equal(claim.normalizeCode(code));
      expect(parsed.passphrase).to.equal("恭喜发财");
    }
  });

  it("keeps the packet, code and passphrase when the first-timer guide is attached", () => {
    const code = claim.newCode();
    for (const lang of ["zh", "en"]) {
      const line = share.formatShare({ id: 7n, code, passphrase: "好运", lang });
      const msg = share.inviteText({ share: line, intro: "BNB 社区 #1 红包群", url: "https://www.agentid.im/p/7?lang=zh", skillUrl: "https://www.agentid.im/skill/agent-redpackets.zip", lang });
      const parsed = share.parseShare(msg);
      expect(parsed.id).to.equal(7n);
      expect(parsed.code).to.equal(claim.normalizeCode(code));
      expect(parsed.passphrase).to.equal("好运");
    }
  });

  it("finds no passphrase in a guide-only message", () => {
    const msg = share.inviteText({ lead: "I sent red packet #3", url: "https://www.agentid.im/p/3?lang=en", skillUrl: "https://x/y.zip", lang: "en" });
    const parsed = share.parseShare(msg);
    expect(parsed.id).to.equal(3n);
    expect(parsed.code).to.equal(null);
    expect(parsed.passphrase).to.equal("");
  });
});
