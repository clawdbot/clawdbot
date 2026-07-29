export async function parsePropertyQuery(query: string) {
  const cityMatch = query.match(
    /in ([A-Za-z\s]+?)(?:\s+under|\s+with|\s+at|\s+that|\s+which|,|$)/i,
  );
  const priceMatch = query.match(/under \$?([\d,.]+)(k|m)?/i);
  const bedsMatch = query.match(/(\d+(?:\.5)?)[\s-]*(bed|beds|bedroom|bedrooms)/i);
  const bathsMatch = query.match(/(\d+(?:\.5)?)[\s-]*(bath|baths|bathroom)/i);
  const sqftMatch = query.match(/(\d+)[\s,]*(sqft|sq ft|square feet)/i);
  const poolMatch = /pool/i.test(query);
  const viewMatch = /view/i.test(query);
  const typeMap: Record<string, string> = {
    condo: "Condominium",
    townhome: "Townhouse",
    "single family": "SingleFamilyResidence",
    land: "UnimprovedLand",
  };
  const typeKey = Object.keys(typeMap).find((k) => query.toLowerCase().includes(k));
  let maxPrice = null;
  if (priceMatch) {
    maxPrice = Number(priceMatch[1].replace(/,/g, ""));
    if (priceMatch[2]?.toLowerCase() === "k") maxPrice *= 1000;
    if (priceMatch[2]?.toLowerCase() === "m") maxPrice *= 1_000_000;
  }
  return {
    city: cityMatch?.[1]?.trim() || null,
    maxPrice,
    beds: bedsMatch ? Math.ceil(Number(bedsMatch[1])) : null,
    baths: bathsMatch ? Math.ceil(Number(bathsMatch[1])) : null,
    sqft: sqftMatch ? Number(sqftMatch[1]) : null,
    type: typeKey ? typeMap[typeKey] : null,
    pool: poolMatch ? "True" : null,
    hasView: viewMatch ? "True" : null,
  };
}

// const query = process.argv[2];
// const result = await parsePropertyQuery(query);
// console.log(JSON.stringify(result));
