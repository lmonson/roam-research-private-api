#!/usr/bin/env node
const helpText=`
The command exposed here (roam-evernote-sync sync) will sync your Roam Graph to your Evernote database.
Depending on a few configuration options, it will:
1. Download payload from external URL to import INTO roam (useful for connecting with other services)
2. Take all notes in your default Evernote notebook and import them into your daily note. They will be marked with 'RoamImported' tag to prevent doing so multiple times
3. Export all notes from your Roam and import them to "Roam" notebook in your Evernote account
4. The backlinks will be kept intact, notes will be updated when possible
5. After all that is done, DB will be pushed to external URL ('exporturl') if provided to provide connection for https://deliber.at/roam/wp-roam-block or similar projects

- 'dir' is a directory where database will be downloaded.
- 'mappingcachefile' is a JSON file that provides a cache for Roam UID <-> Evernote GUID mapping. This is used to relieve Evernote API a bit
`;

const yargs = require( 'yargs' );
const fetch = require( 'node-fetch' );
var fs = require( 'fs' ).promises;

const argv = yargs
	.option( 'graph', {
		alias: 'g',
		description: 'Your graph name',
		type: 'string',
	} )
	.option( 'email', {
		alias: 'e',
		description: 'Your Roam Email',
		type: 'string',
	} )
	.option( 'password', {
		alias: 'p',
		description: 'Your Roam Password',
		type: 'string',
	} )
	.option( 'evernote_token', {
		alias: 't',
		description: 'Your Evernote Token',
		type: 'string',
	} )
	.option( 'debug', {
		description: 'enable debug mode',
		type: 'boolean',
		default: false,
	} )
	.option( 'nodownload', {
		description: 'Skip the download of the roam graph. Default no - do download.',
		type: 'boolean',
		default: false,
	} )
	.option( 'nosandbox', {
		description: 'Skip the Chrome Sandbox.',
		type: 'boolean',
		default: false,
	} )
	.option( 'executable', {
		description: 'Executable path to Chromium.',
		type: 'string',
		default: '',
	} )
	.option( 'verbose', {
		alias: 'v',
		description: 'You know, verbose.',
		type: 'boolean',
		default: false,
	} )
	.option( 'privateapiurl', {
		description: 'Additional endpoint that provides data to sync INTO Roam. Has nothing to do with Evernote, its just convenient.',
		type: 'string',
		default: '',
	} )
	.option( 'removezip', {
		description: 'If downloading the Roam Graph, should the timestamp zip file be removed after downloading?',
		type: 'boolean',
		default: true,
	} )
	.command(
		'sync <dir> <mappingcachefile> [exporturl]',
		helpText,
		() => {},
		( argv ) => {

			const RoamPrivateApi = require( '../' );
			const EvernoteSyncAdapter = require( '../EvernoteSync' );
			const options = {
				headless: ! argv.debug,
				nodownload: argv.nodownload,
				folder: argv['dir']
			};
			if ( argv[ 'executable' ] ) {
				options['executablePath'] = argv[ 'executable' ];
			}
			if ( argv[ 'nosandbox' ] ) {
				options['args'] = ['--no-sandbox', '--disable-setuid-sandbox'];
			}

			const e = new EvernoteSyncAdapter( { token: argv.evernoteToken, sandbox: false }, argv.graph );
			const api = new RoamPrivateApi( argv.graph, argv.email, argv.password, options );

			// This downloads the private additional content for my Roam graph, served by other means.
			const importIntoRoam = [];
			if ( argv.privateapiurl ) {
				const private_api = fetch( argv.privateapiurl ).then( response => response.json() );
				private_api.then( data => console.log( 'Private API payload', JSON.stringify( data, null, 2 ) ) );
				importIntoRoam.push( private_api );
			}

			let evernote_to_roam;
			if ( argv.mappingcachefile ) {
				// There is a mapping file.
				evernote_to_roam = fs.readFile( argv.mappingcachefile )
				.then( ( data ) => e.init( JSON.parse( data ) ) )
				.catch( ( err ) => e.init( null ) )
			} else {
				evernote_to_roam = e.init( null );
			}

			// This finds notes IN Evernote to import into Roam:
			evernote_to_roam = evernote_to_roam
				.then( () => e.getNotesToImport() )
				.then( payload => Promise.resolve( e.getRoamPayload( payload ) ) );
				importIntoRoam.push( evernote_to_roam );

			// Let's start the flow with Roam:
			const roamdata = Promise.all( importIntoRoam )
				.then( results => {
					const payload = results[0].concat( results[1] );
					console.log( 'Importing into Roam', JSON.stringify( payload, null, 2 ) );
					if( payload.length > 0 ) {
						return api.import( payload );
					} else {
						return Promise.resolve();
					}
				} )
				.then( () => e.cleanupImportNotes() )
				.then( () => api.getExportData( ! argv.nodownload && argv['removezip'] ) ); // Removing zip is only possible if we downloaded it.

				// We are saving the intermediate step of mapping just in case.
				if ( argv.mappingcachefile ) {
					roamdata.then( data => fs.writeFile( argv.mappingcachefile, JSON.stringify( [ ...e.mapping ], null, 2 ), 'utf8' ) );
				}

				// This will push Roam graph to the URL of your choice - can be WordPress
				if ( argv.exporturl ) {
					roamdata.then( data => fetch( argv.exporturl, {
						method: 'post',
						body: JSON.stringify( {
							graphContent: data,
							graphName: api.db
						} ),
						headers: {'Content-Type': 'application/json'}
					} ) )
					.then( response => response.text() )
					.then( ( data ) => console.log( 'Updated in your remote URL', data ) );
				}

				// This is the actual moment where we sync to Evernote:
				let finish = roamdata.then( ( data ) => e.processJSON( data ) );
				// We are saving the final step of mapping just in case.
				if ( argv.mappingcachefile ) {
					finish = finish.then( data => fs.writeFile( argv.mappingcachefile, JSON.stringify( [ ...e.mapping ], null, 2 ), 'utf8' ) );
				}
				finish.then( () => console.log( 'success' ) );
		}
	)
	.help()
	.alias( 'help', 'h' )
	.env( 'ROAM_API' )
	.demandOption(
		[ 'graph', 'email', 'password' ],
		'You need to provide graph name, email and password'
	).argv;
