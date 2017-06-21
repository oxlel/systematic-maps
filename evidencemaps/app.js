console.log("Loaded app.js");

// Requires knockout and d3v4
function EvidenceMapToolViewModel() {

        var self = this;

        self.id = ko.observable();
        self.title = ko.observable();

        
}

var vm = new EvidenceMapToolViewModel();

// D3.js map
var width = 800;
var height = 800;
let aggregationDistance = 150;
let numberOfPoints = 3.
var maxControlCount = 110;

// SVG variables
var svg = d3.select("#map");
var g = svg.append("g");

var g1 = g.append("g"); // background
var g2 = g.append("g"); // pie charts

// // Projection variables
// var projection = d3.geoAzimuthalEquidistant()
//     .scale(600)
//     .translate([width / 2, height / 2])
//     .rotate([-10,-90])
//     .precision(0.01);
var projection = d3.geoOrthographic()
    .scale(600)
    .translate([500, 350])
    .clipAngle(90)
    .rotate([0,-90])
    .precision(0);

var minZ, // minimum area threshold for simplification
    transform = d3.geoIdentity().clipExtent([[0, 0], [width, height]]),
    simplify = d3.geoTransform({point: function(x, y, z) { if (z >= minZ) this.stream.point(x, y); }});

var zoom = d3.zoom()
    .scaleExtent([1 / (1 << 5), 1 << 2])
    .on("zoom", zoomed);


var path = d3.geoPath().projection(projection);

// Draw geographic features
d3.json("layers/world110.json", function(error, world) {
    g1.insert("path", ".land")
		.datum(topojson.feature(world, world.objects.countries))
		.attr("class", "land")
		.attr("d", path)
        .attr('fill', '#E5E3DF');
		
	g1.append("path")
      .datum(topojson.mesh(world, world.objects.countries, function(a, b) { return a !== b; }))
      .attr("class", "mesh")
      .attr("d", path)
      .attr('fill', 'none')
      .attr('stroke', 'white')
      .attr('stroke-width', '0.5px');

      // Draw bioclimatic subzones
    d3.json("layers/subzones.json", function(error, subzones) {
        var geojson = topojson.feature(subzones, subzones.objects.collection).features;

        let subzoneColours = function(zone) {
            if (zone == "Glacier") return "#e1e1e1";
            if (zone == "Oroarctic") return "#a8baad";
            if (zone == "A") return "#f0ad70";
            if (zone == "B") return "#edcc71";
            if (zone == "C") return "#efee70";
            if (zone == "D") return "#c3d370";
            if (zone == "E") return "#9bb96f";
            return "#e1e1e1";
        }

        g1.append("g")
            .selectAll('path', '.subzone')
            .data(geojson)
            .enter()
            .append('path')
            .attr('class', function(d) { return "subzone-" + d.properties.subzone; })
            .attr('d', path)
            .attr('fill', function(d) { return subzoneColours(d.properties.subzone);})
    });

});

var palette;
let getColour = function(controlName) {
    let match = _.find(palette, function(item) { return item.name == controlName; });
    if (match == null) { console.log(controlName); return "black"; }
    return match.color;
}

d3.json("palette.json", function(error, palData) {
    palette = palData.palette;
})

// Draw pies from data
d3.csv("maps/arcticshrub.csv", function(error, rawData) {


    // Sort data by category, then by display unit
    var sortedData =
        _(rawData)
        .chain()
        .sortBy('Category')
        .sortBy('DisplayUnit');

    sortedData =
        _(sortedData)
        .filter(function(dp) {
            return dp.ControlType === "PROX";
        })
        .filter(function(dp) {
            return !(dp.Extent === "Pan-Arctic" || dp.Extent === "Continent");
        })
        // .filter(function(dp) {
        //     return dp.ControlType === "ULT";
        // })
        // .filter(function(dp) {
        //     return !(dp.DisplayUnit === "2 Air Temperature" || dp.DisplayUnit === "13 Soil Moisture");
        // })
        ._wrapped;

    console.log(sortedData);

    // Aggregation
    var cluster = function(points, searchDistance, minPointsPerCluster) {
        let clusterRecursive = function(remainingPoints, clusters) {
            let currentPoint = {
                "type": "Feature",
                "properties": remainingPoints[0],
                "geometry": {
                    "type": "Point",
                    "coordinates": [parseInt(remainingPoints[0].LonDD), parseInt(remainingPoints[0].LatDD)]
                }
            };
            let nearby =
                _.filter(remainingPoints, function(dataPoint) {
                    let turfTo = {
                        "type": "Feature",
                        "properties": dataPoint,
                        "geometry": {
                            "type": "Point",
                            "coordinates": [parseInt(dataPoint.LonDD), parseInt(dataPoint.LatDD)]
                        }
                        };

                    let distance = turf.distance(currentPoint, turfTo, "kilometers");
                    return distance < searchDistance;
                });
            
            let clusterFeatures = turf.featureCollection(
                _
                .map(nearby, function(dataPoint) {
                    return {
                        "type": "Feature",
                        "properties": dataPoint,
                        "geometry": {
                            "type": "Point",
                            "coordinates": [parseFloat(dataPoint.LonDD), parseFloat(dataPoint.LatDD)]
                        }
                    }
                }));

            let centroid = turf.centroid(clusterFeatures);
            let newCluster = { 
                "centroid": centroid,
                "points": nearby };
            clusters.push(newCluster);
            
            let pointsMinusCluster = _.difference(remainingPoints,nearby);
            if (pointsMinusCluster.length > 0) {
                return clusterRecursive(pointsMinusCluster, clusters);
            }
            else {
                return clusters;
            }
        }
        return clusterRecursive(points, []);
    }

    var clusteredData = cluster(sortedData, aggregationDistance, numberOfPoints);

    // Sort data into pies based on properties of interest
    // Size = total count
    // Categories,Value = control name,occurrence count

    var pieScale = 
        d3.scalePow()
        .domain([0,maxControlCount])
        .range([3.5,25.5])
        .exponent(1);

    let maxTemp = 0;

    var clusteredDataPies =
        _.map(clusteredData, function(cluster) {
            
            var catsWithValues = 
                _.reduce(cluster.points, function(controls, point) {
                    let cat = point.DisplayUnit;
                    let existingCat = _.where(controls, {category: cat});
                    if (existingCat.length == 0) {
                        controls.push({ category: cat, value: 1 });
                        return controls;
                    } else {
                        let updatedCat = {category: cat, value: existingCat[0].value++ };
                        for (var i = 0, l = controls.length; i < l; i++)
                        {
                            var el = controls[i];
                            if (el.category == updatedCat) {
                                controls[i] = updatedCat;
                                break;
                            }
                        }
                        return controls;
                    }
                }, []);

            let total = 0;
            catsWithValues.forEach(function(cat) { total = total + cat.value; })

            if (total > maxTemp) maxTemp = total;

            //Stash pie sizes here, for access when drawing pie segments later
            let pieSize = pieScale(total);
            catsWithValues.forEach(function(a){ a.radius = pieSize; });

            return { centroid: cluster.centroid, categories: catsWithValues, total: total }
        });

    displayPies(clusteredDataPies);
    svg.call(zoom);
});

function displayPies(clusteredDataPies) {
    var pie = d3.pie()
                .value(function(cat) { return cat.value; })
                .sort(null);

    var arc = d3.arc()
        .outerRadius(function(d){ return d.data.radius; })
        .innerRadius(0);

    var arcOuter = d3.arc() //(This is the outline for the pie chart)
        .innerRadius(function(d){ return d.data.radius; })
        .outerRadius(function(d){ return d.data.radius + 1; })

    var points = g2.selectAll('g')
        .data(clusteredDataPies)
        .enter()
        .append('g')
		.attr("transform",function(d) { return "translate("+projection([d.centroid.geometry.coordinates[0],d.centroid.geometry.coordinates[1]])+")" })
		.attr("class","pies");

    var pies = points.selectAll('path')
        .data(function(d) { return pie(d.categories); })
        .enter()
        .append('path')
        .attr('d', arc)
        .attr('fill', function(d, i) {
            return getColour(d.data.category);
        });

    var pies = points.selectAll('path.outline')
        .data(function(d) { return pie(d.categories); })
        .enter()
        .append('path')
        .attr('d', arcOuter)
        .attr('fill', 'black');
}

function zoomed() {
  g.style("stroke-width", 1.5 / d3.event.transform.k + "px");
  // g.attr("transform", "translate(" + d3.event.translate + ")scale(" + d3.event.scale + ")"); // not in d3 v4
  g.attr("transform", d3.event.transform); // updated for d3 v4
}
