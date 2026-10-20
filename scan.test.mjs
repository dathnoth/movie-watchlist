import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = {};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(readFileSync(new URL('./scan.js', import.meta.url), 'utf8'), context);

const { parseMovieName, compareLibrary, collectMovieEntries, directoryHandleFromPaths, normalizeTitle } = context;
// Results are born in the vm realm, so bring them back before deep-equal.
const local = (value) => JSON.parse(JSON.stringify(value));

const movies = [
    { imdb_id: 'tt1', title: 'Dune', year: '22 Oct 2021', status: 'get', is_tv_show: false },
    { imdb_id: 'tt2', title: 'The Matrix', year: '1999', status: 'got', is_tv_show: false },
    { imdb_id: 'tt3', title: 'Arrival', year: '2016', status: 'got', is_tv_show: false },
    { imdb_id: 'tt4', title: 'Blade Runner', year: '25 Jun 1982', status: 'archive', is_tv_show: false },
    { imdb_id: 'tt5', title: 'The Office', year: '2005', status: 'got', is_tv_show: true },
    { imdb_id: 'tt6', title: 'Dune', year: '1984', status: 'get', is_tv_show: false },
    { imdb_id: 'tt7', title: 'Heat', year: '15 Dec 1995', status: 'got', is_tv_show: false },
    { imdb_id: 'tt8', title: "Ocean's Eleven", year: '2001', status: 'get', is_tv_show: false },
    { imdb_id: 'tt9', title: 'The Godfather Part II', year: '1974', status: 'got', is_tv_show: false },
    { imdb_id: 'tt10', title: 'Crash', year: '2004', status: 'got', is_tv_show: false },
    { imdb_id: 'tt11', title: 'Crash', year: '1996', status: 'get', is_tv_show: false },
];

function names(list) {
    return local(list).map((item) => item.title).sort();
}

const report = compareLibrary(movies, [
    { name: 'Dune (2021)', title: 'Dune', year: '2021' },
    { name: 'Dune (2021) {tmdb-438631}', title: 'Dune', year: '2021' },
    { name: 'Matrix (1999)', title: 'Matrix', year: '1999' },
    { name: 'Blade Runner (1982)', title: 'Blade Runner', year: '1982' },
    { name: 'Dune (1984) [1080p]', title: 'Dune', year: '1984' },
    { name: "Ocean's Eleven (2001)", title: "Ocean's Eleven", year: '2001' },
    { name: 'The Godfather Part 2 (1974)', title: 'The Godfather Part 2', year: '1974' },
    { name: 'Nope (2022)', title: 'Nope', year: '2022' },
    { name: 'Heat', title: 'Heat', year: '' },
    { name: 'Crash', title: 'Crash', year: '' },
    { name: 'Oceans Eleven (2001)', title: 'Oceans Eleven', year: '2001' },
]);

assert.deepEqual(names(report.moves), ['Dune', 'Dune', "Ocean's Eleven"]);
assert.equal(report.moves.find((row) => row.imdb_id === 'tt1').folder.includes('Dune (2021)'), true);
assert.equal(report.moves.find((row) => row.imdb_id === 'tt8').folder.includes('Oceans Eleven'), true);
assert.equal(report.already, 3);
assert.equal(report.watched, 1);
assert.deepEqual(names(report.missing), ['Arrival', 'Crash']);
assert.equal(report.tvSkipped, 1);
assert.equal(report.unknown.some((row) => row.name === 'Nope (2022)' && !row.note), true);
assert.equal(report.unknown.some((row) => row.name === 'Crash' && row.note), true);

const sameName = compareLibrary(
    [
        { imdb_id: 'a', title: 'Heat', year: '1995', status: 'got', is_tv_show: false },
        { imdb_id: 'b', title: 'Heat', year: '1986', status: 'get', is_tv_show: false },
    ],
    [{ name: 'Heat (1995)', title: 'Heat', year: '1995' }],
);
assert.equal(sameName.already, 1);
assert.equal(sameName.moves.length, 0);
assert.equal(sameName.missing.length, 0);

assert.equal(parseMovieName('Dune (2021) {tmdb-438631}').year, '2021');
assert.equal(parseMovieName('Dune (2021) [imdbid-tt1160419]').title, 'Dune');
assert.deepEqual(local(parseMovieName('The.Matrix.1999.1080p.mkv')), { title: 'The Matrix', year: '1999', named: true });
assert.deepEqual(local(parseMovieName('Blade Runner 2049 (2017)')), { title: 'Blade Runner 2049', year: '2017', named: true });
assert.equal(parseMovieName('1917 (2019)').title, '1917');
assert.equal(normalizeTitle('The Godfather Part II'), normalizeTitle('The Godfather Part 2'));
assert.equal(normalizeTitle('Amélie'), normalizeTitle('Amelie'));

const paths = [
    'Movies/Dune (2021)/Dune (2021).mkv',
    'Movies/The Matrix (1999)/The Matrix (1999).mkv',
    'Movies/4K/Arrival (2016)/Arrival.mkv',
    'Movies/Nope (2022)/Nope.mkv',
    'Movies/readme.txt',
    'Movies/trailer.mp4',
    'Movies/Extras/behind the scenes.mkv',
    'Movies/.hidden/Secret (2001)/Secret.mkv',
];
const built = directoryHandleFromPaths(paths);
assert.equal(built.folderName, 'Movies');
const entries = await collectMovieEntries(built.handle);
const entryNames = local(entries).map((entry) => entry.name).sort();
assert.deepEqual(entryNames, ['4K/Arrival (2016)', 'Dune (2021)', 'Nope (2022)', 'The Matrix (1999)']);

const fromDisk = compareLibrary(movies, entries);
assert.deepEqual(names(fromDisk.moves), ['Dune']);
assert.equal(fromDisk.already, 2);
assert.ok(fromDisk.missing.some((row) => row.title === 'Heat'));
assert.ok(fromDisk.unknown.some((row) => row.title === 'Nope'));

console.log('scan tests passed');
