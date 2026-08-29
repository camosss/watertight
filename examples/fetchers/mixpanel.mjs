// Example custom fetcher: Mixpanel saved reports.
//
//   watertight refresh . --fetchers ./mixpanel.mjs
//
// Reads credentials from the environment — never from the IR:
//   MIXPANEL_SA_USER    service account username
//   MIXPANEL_SA_SECRET  service account secret
//
// A metric using it carries everything else in its receipt:
//   "source": {
//     "type": "mixpanel",
//     "project": 123456,
//     "bookmark": "aBcDeF",
//     "path": "series.Conversion.all"
//   }
//
// `path` plucks the value out of the Insights API response, because every
// saved report has its own shape — the receipt says where the number lives.

export async function mixpanel(source) {
  const user = process.env.MIXPANEL_SA_USER
  const secret = process.env.MIXPANEL_SA_SECRET
  if (!user || !secret) throw new Error('set MIXPANEL_SA_USER and MIXPANEL_SA_SECRET')

  const url = new URL('https://mixpanel.com/api/query/insights')
  url.searchParams.set('project_id', String(source.project))
  url.searchParams.set('bookmark_id', String(source.bookmark))

  const res = await fetch(url, {
    headers: { authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}` },
  })
  if (!res.ok) throw new Error(`mixpanel ${res.status} for bookmark ${source.bookmark}`)

  let node = await res.json()
  for (const part of String(source.path).split(/[.[\]]+/).filter(Boolean)) {
    node = node?.[part]
  }
  return node
}
