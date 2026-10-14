import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GROUP_MUTE_BATCH_LIMIT,
  GROUP_MUTE_MAX_SECONDS,
  buildMuteExpireAt,
  buildMuteRequests,
  normalizeMuteMember,
  normalizeMuteMembers,
  chunkMuteMembers
} from '../lib/groupMute.js'

const A = 'EC58D87F598C8294A533B9D458DAAF33'
const B = 'AA11BB22CC33DD44EE55FF6677889900'

test('字符串成员按默认时长禁言', () => {
  const member = normalizeMuteMember(A, 600)
  assert.equal(member.op, 'add')
  assert.equal(member.member_openid, A)
  assert.ok(Math.abs(new Date(member.mute_expire_at).getTime() - (Date.now() + 600000)) < 5000)
})

test('字符串成员没有默认时长时不带 mute_expire_at', () => {
  const member = normalizeMuteMember(A)
  assert.deepEqual(member, { op: 'add', member_openid: A })
})

test('duration > 0 走 add，duration <= 0 走 del 且到期时间为空串', () => {
  assert.equal(normalizeMuteMember({ member_openid: A, duration: 60 }).op, 'add')
  const banned = normalizeMuteMember({ member_openid: A, duration: 0 })
  assert.deepEqual(banned, { op: 'del', member_openid: A, mute_expire_at: '' })
  assert.equal(normalizeMuteMember({ member_openid: A, duration: -1 }).op, 'del')
})

test('兼容 user_id / openid / raw_user_id 字段名', () => {
  assert.equal(normalizeMuteMember({ user_id: A, duration: 10 }).member_openid, A)
  assert.equal(normalizeMuteMember({ openid: A, duration: 10 }).member_openid, A)
  assert.equal(normalizeMuteMember({ raw_user_id: A, duration: 10 }).member_openid, A)
})

test('显式 op 优先于 duration 推断', () => {
  assert.equal(normalizeMuteMember({ member_openid: A, op: 'update', duration: 300 }).op, 'update')
  assert.equal(normalizeMuteMember({ member_openid: A, op: 'del', duration: 300 }).mute_expire_at, '')
})

test('显式 mute_expire_at 直接透传（RFC3339）', () => {
  const member = normalizeMuteMember({ member_openid: A, op: 'add', mute_expire_at: '2026-08-05T11:23:05+08:00' })
  assert.deepEqual(member, { op: 'add', member_openid: A, mute_expire_at: '2026-08-05T11:23:05+08:00' })
})

test('非法 op 被忽略，回落到 duration 推断', () => {
  const member = normalizeMuteMember({ member_openid: A, op: 'remove', duration: 60 })
  assert.equal(member.op, 'add')
})

test('超过 30 天的时长被夹紧到 30 天', () => {
  const member = normalizeMuteMember({ member_openid: A, duration: GROUP_MUTE_MAX_SECONDS * 3 })
  const delta = new Date(member.mute_expire_at).getTime() - Date.now()
  assert.ok(Math.abs(delta - GROUP_MUTE_MAX_SECONDS * 1000) < 5000)
})

test('buildMuteExpireAt 对非正数返回空串', () => {
  assert.equal(buildMuteExpireAt(0), '')
  assert.equal(buildMuteExpireAt(-5), '')
  assert.equal(buildMuteExpireAt('abc'), '')
})

test('缺少成员标识的条目被丢弃', () => {
  assert.equal(normalizeMuteMember({ duration: 60 }), null)
  assert.equal(normalizeMuteMember(''), null)
  assert.equal(normalizeMuteMember(null), null)
  assert.deepEqual(normalizeMuteMembers([null, { duration: 1 }, '  ', A], 60).length, 1)
})

test('按 openid 去重且后者覆盖前者', () => {
  const members = normalizeMuteMembers([
    { member_openid: A, duration: 600 },
    { member_openid: B, duration: 60 },
    { member_openid: A, duration: 0 }
  ])
  assert.equal(members.length, 2)
  const a = members.find(item => item.member_openid === A)
  assert.equal(a.op, 'del')
  assert.equal(members.find(item => item.member_openid === B).op, 'add')
})

test('单个对象会被包装成数组', () => {
  const members = normalizeMuteMembers({ member_openid: A, duration: 60 })
  assert.equal(members.length, 1)
  assert.equal(members[0].member_openid, A)
})

test('默认时长对对象条目同样生效', () => {
  const members = normalizeMuteMembers([{ user_id: A }, { user_id: B, duration: 0 }], 600)
  assert.equal(members.find(item => item.member_openid === A).op, 'add')
  assert.equal(members.find(item => item.member_openid === B).op, 'del')
})

test('分片按 20 个一组，末片保留余数', () => {
  assert.equal(GROUP_MUTE_BATCH_LIMIT, 20)
  const members = Array.from({ length: 45 }, (_, i) => ({ op: 'add', member_openid: `M${i}` }))
  const chunks = chunkMuteMembers(members)
  assert.deepEqual(chunks.map(chunk => chunk.length), [20, 20, 5])
  assert.equal(chunks.flat().length, 45)
  assert.equal(chunks[2][4].member_openid, 'M44')
})

test('分片函数对空列表与自定义上限', () => {
  assert.deepEqual(chunkMuteMembers([]), [])
  const members = Array.from({ length: 5 }, (_, i) => ({ op: 'add', member_openid: `M${i}` }))
  assert.deepEqual(chunkMuteMembers(members, 2).map(chunk => chunk.length), [2, 2, 1])
  assert.deepEqual(chunkMuteMembers(members, 0).map(chunk => chunk.length), [5])
})

test('buildMuteRequests 会把框架 userId 还原成官方 member_openid', () => {
  const batches = buildMuteRequests(
    [{ user_id: '10001:bot1234:EC58D87F598C8294A533B9D458DAAF33', duration: 600 }],
    0,
    value => String(value).split(':').pop()
  )
  assert.equal(batches.length, 1)
  assert.equal(batches[0][0].member_openid, A)
  assert.equal(batches[0][0].op, 'add')
})

test('buildMuteRequests 还原后重复的 openid 只保留最后一条', () => {
  const batches = buildMuteRequests(
    [
      { user_id: 'bot1:EC58D87F598C8294A533B9D458DAAF33', duration: 600 },
      { user_id: 'bot2:EC58D87F598C8294A533B9D458DAAF33', duration: 0 }
    ],
    0,
    value => String(value).split(':').pop()
  )
  assert.equal(batches.length, 1)
  assert.equal(batches[0].length, 1)
  assert.equal(batches[0][0].op, 'del')
})

test('buildMuteRequests 还原后为空的成员被丢弃，全部无效时返回空数组', () => {
  const resolve = value => String(value).split(':').pop()
  assert.deepEqual(buildMuteRequests([{ user_id: 'bot1:' }, { user_id: 'bot2:' }], 60, resolve), [])
  assert.deepEqual(buildMuteRequests([], 60, resolve), [])
})

test('buildMuteRequests 45 人自动分成 20/20/5 三批', () => {
  const members = Array.from({ length: 45 }, (_, i) => ({ user_id: `bot1:M${i}`, duration: 60 }))
  const batches = buildMuteRequests(members, 0, value => String(value).split(':').pop())
  assert.deepEqual(batches.map(batch => batch.length), [20, 20, 5])
  assert.equal(batches[0][0].member_openid, 'M0')
  assert.equal(batches[2][4].member_openid, 'M44')
})

test('buildMuteRequests 未传 resolveOpenid 时按原值使用', () => {
  const batches = buildMuteRequests([A], 60)
  assert.equal(batches[0][0].member_openid, A)
})
