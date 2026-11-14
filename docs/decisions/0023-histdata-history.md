# 0023: Older years from HistData.com, and news candles kept

- **Date:** 14 Nov 2026
- **Status:** accepted
- **Decided by:** Yuvraj Sharma (wanted the past data from anywhere, not only MT5), with Claude on how

## Source

MT5 stops at its "Max bars in chart" ([0022](0022-older-candles.md)). Two free sources were tried:

- **Dukascopy** (datafeed.dukascopy.com): M1 candles per day, prices within 0.3 pip of the broker's, but the server answered most requests with 503s or timeouts: twelve files took four minutes.
- **HistData.com**: one 3 MB zip of M1 bars per year, a second or two each. Chosen.

`python -m forex_replay backfill --from 2023-01-01` now uses HistData.com (`--source mt5` keeps the old way). It writes `data/EURUSD_M5_histdata.csv`, which `find_exports` merges first, like the Yahoo fill, so the broker's files win any overlap; the backfill only fetches candles before the broker's first one anyway. The data runs from Mon 2 Jan 2023: 278,616 candles (150,905 from HistData).

## Clock and prices

HistData says its times are EST without daylight saving. Compared with the broker over 2025 they are not: they line up only when read as UTC-5 moved with **European** daylight saving (UTC = stamp + 5h, taken as London time). Read that way every month of 2025 matches; read as plain EST, the summer was an hour off, and read as New York time, the weeks when the US and Europe disagree (March, late October) were.

Prices then sit within 0.2-0.3 pip of the broker's: median difference -2 points on opens and closes, -3 on highs, 0 on lows. Not shifted: it is a different feed, and close enough for replay. HistData has no volume and no spread: volume is 0 (the volume bars are empty before 25 Feb 2025) and the spread is the broker's usual one over its first 20 days (0 on this raw-spread account).

## Spike check

The first run dropped 20 candles as spikes, and they were real: CPI on 12 Apr 2023, 13 Feb 2024 and 10 Apr 2024, FOMC on 14 Jun 2023, NFP on 7 Jun 2024, thin Christmas mornings, and the 3 Feb 2025 Monday gap. The check (range over 15 times the median of the 48 candles around it) runs on the daily broker update too, so it is changed for both:

- a huge range is a bad tick only if the price is back where it was by the close or the next open, or the range is over 1% (news on EURUSD stays well under that in five minutes);
- the median range counts as at least one pip, so holiday mornings don't make ordinary candles look huge;
- the first candle after a break of over 12 hours (Monday) may gap.

No candles were missing from the broker's own files, so nothing there needs fetching again.

## Speed

47 monthly files, 8 MB of web data (3.7 MB before). Locally all of them load in about 0.14 s; a replay step in Feb 2024 takes about 1 ms.
