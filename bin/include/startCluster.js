exports['startCluster'] = function(binary, next){

	//////////////////////////////////////////////////////////////////////////////////////////////////////
	// 
	// TO START IN CONSOLE: `./bin/actionHero startCluster`
	// TO DAMEONIZE: `forever ./bin/actionHero startCluster` 
	// 
	// ** Producton-ready actionHero cluster **
	// - be sure to enable redis so that workers can share state
	// - workers which die will be restarted
	// - maser/manager specific logging
	// - pidfile for master
	// - USR2 restarts (graceful reload of workers while handling requets)
	//   -- Note, socket/websocket clients will be disconnected, but there will always be a worker to handle them
	//   -- HTTP, HTTPS, and TCP clients will be allowed to finish the action they are working on before the server goes down
	// - TTOU and TTIN signals to subtract/add workers
	// - WINCH to stop all workers
	// - TCP, HTTP(s), and Web-socket clients will all be shared across the cluster
	// - Can be run as a daemon or in-console
	//   -- Lazy Dameon: `nohup ./bin/actionHero startCluster &`
	//   -- you may want to explore `forever` as a dameonizing option
	//
	// * Setting process titles does not work on windows or OSX
	// 
	// This example was heavily inspired by Ruby Unicorns [[ http://unicorn.bogomips.org/ ]]
	// 
	//////////////////////////////////////////////////////////////////////////////////////////////////////

	var cluster = require('cluster');

	binary.async.series({
		setup: function(next){
			binary.numCPUs = require('os').cpus().length
			binary.numWorkers = binary.numCPUs - 2;
			if (binary.numWorkers < 2){ binary.numWorkers = 2};

			binary.utils.dir_exists("node_modules/actionHero/", function(){
				binary.execCMD = binary.project_root + "/node_modules/actionHero/bin/actionHero";
				next();
			}, function(){
				binary.execCMD = binary.project_root + "/bin/actionHero";
				next();
			});
		},
		pids: function(next){
			binary.pidPath = process.cwd() + "/pids";
			try{
				stats = binary.fs.lstatSync(binary.pidPath);
				if(!stats.isDirectory()){
					binary.fs.mkdirSync(binary.pidPath);
				}
			}catch(e){
				binary.fs.mkdirSync(binary.pidPath);
			}
			next();
		},
		config: function(next){
			binary.clusterConfig = {
				exec: binary.execCMD, 
				args: "start",
				workers: binary.numWorkers,
				pidfile: binary.pidPath + "/cluster_pidfile",
				log: process.cwd() + "/log/cluster.log",
				title: "actionHero-master",
				workerTitlePrefix: "actionHero-worker",
				silent: true, // don't pass stdout/err to the master
			};

			for(var i in binary.clusterConfig){
				if(binary.argv[i] != null){
					binary.clusterConfig[i] = binary.argv[i];
				}
			}

			if(binary.clusterConfig.silent == "false"){ binary.clusterConfig.silent = false; }
			if(binary.clusterConfig.silent == "true"){ binary.clusterConfig.silent = true; }
			binary.clusterConfig.args = binary.clusterConfig.args.split(",");

			next();
		},
		log: function(next){
			binary.logWriter = binary.fs.createWriteStream((binary.clusterConfig.log), {flags:"a"});

			binary.originalLog = binary.log;
			binary.log = function(message, styles){
				binary.logWriter.write(message + "\r\n");
				binary.originalLog(message, styles);
			}

			next();
		},
		displaySetup: function(next){
			binary.log(" - STARTING CLUSTER -", ["bold", "green"]);
			binary.log("options:");
			for(var i in binary.clusterConfig){
				binary.log(" > " + i + ": " + binary.clusterConfig[i]);
			}
			binary.log("");

			next();
		},
		pidFile: function(next){
			if(binary.clusterConfig.pidfile != null){
				binary.fs.writeFileSync(binary.clusterConfig.pidfile, process.pid.toString(), 'ascii');
			}

			next();
		},
		workerMethods: function(next){
			binary.startAWorker = function(){
				var worker = cluster.fork({
					title: binary.clusterConfig.workerTitlePrefix + (binary.utils.hashLength(cluster.workers) + 1)
				});
				binary.log("starting worker #" + worker.id);
				worker.on('message', function(message){
					if(worker.state != "none"){
						binary.log("Message ["+worker.process.pid+"]: " + message);
					}
				});
			}

			binary.setupShutdown = function(){
				binary.log("Cluster manager quitting", "red", "bold");
				binary.log("Stopping each worker...");
				for(var i in cluster.workers){
					cluster.workers[i].send('stop');
				}
				setTimeout(binary.loopUntilNoWorkers, 1000);
			}

			binary.loopUntilNoWorkers = function(){
				if(cluster.workers.length > 0){
					binary.log("there are still " + binary.utils.hashLength(cluster.workers) + " workers...");
					setTimeout(loopUntilNoWorkers, 1000);
				}else{
					binary.log("all workers gone");
					if(binary.clusterConfig.pidfile != null){
						try{ binary.fs.unlinkSync(binary.clusterConfig.pidfile); }catch(e){ }
					}
					process.exit();
				}
			}

			binary.loopUntilAllWorkers = function(){
				if(binary.utils.hashLength(cluster.workers) < binary.workersExpected){
					binary.startAWorker();
					setTimeout(binary.loopUntilAllWorkers, 1000);
				}
			}

			binary.reloadAWorker = function(next){
				var count = 0;
				for (var i in cluster.workers){ count++; }
				if(binary.workersExpected > count){
					binary.startAWorker();
				}
				if(binary.workerRestartArray.length > 0){
					var worker = binary.workerRestartArray.pop();
					worker.send("stop");
				}
			}

			next();
		},
		process: function(next){
			process.stdin.resume();
			process.title = binary.clusterConfig.title;
			binary.workerRestartArray = []; // used to trask rolling restarts of workers
			binary.workersExpected = 0;

			// signals
			process.on('SIGINT', function(){
				binary.log("Signal: SIGINT");
				binary.workersExpected = 0;
				binary.setupShutdown();
			});
			process.on('SIGTERM', function(){
				binary.log("Signal: SIGTERM");
				binary.workersExpected = 0;
				binary.setupShutdown();
			});
			process.on('SIGKILL', function(){
				binary.log("Signal: SIGKILL");
				binary.workersExpected = 0;
				binary.setupShutdown();
			});
			process.on('SIGUSR2', function(){
				binary.log("Signal: SIGUSR2");
				binary.log("swap out new workers one-by-one");
				binary.workerRestartArray = [];
				for(var i in cluster.workers){
					binary.workerRestartArray.push(cluster.workers[i]);
				}
				binary.reloadAWorker();
			});
			process.on('SIGHUP', function(){
				binary.log("Signal: SIGHUP");
				binary.log("reload all workers now");
				for (var i in cluster.workers){
					var worker = cluster.workers[i];
					worker.send("restart");
				}
			});
			process.on('SIGWINCH', function(){
				binary.log("Signal: SIGWINCH");
				binary.log("stop all workers");
				binary.workersExpected = 0;
				for (var i in cluster.workers){
					var worker = cluster.workers[i];
					worker.send("stop");
				}
			});
			process.on('SIGTTIN', function(){
				binary.log("Signal: SIGTTIN");
				binary.log("add a worker");
				binary.workersExpected++;
				binary.startAWorker();
			});
			process.on('SIGTTOU', function(){
				binary.log("Signal: SIGTTOU");
				binary.log("remove a worker");
				binary.workersExpected--;
				for (var i in cluster.workers){
					var worker = cluster.workers[i];
					worker.send("stop");
					break;
				}
			});
			process.on("exit", function(){
				binary.workersExpected = 0;
				binary.log("Bye!")
			});
			next();
		},
		start: function(next){
			cluster.setupMaster({
				exec : binary.clusterConfig.exec,
				args: binary.clusterConfig.args,
				silent : binary.clusterConfig.silent
			});

			process.title = binary.clusterConfig.title;

			for (var i = 0; i < binary.clusterConfig.workers; i++) {
				binary.workersExpected++;
			}
			cluster.on('fork', function(worker) {
				binary.log("worker " + worker.process.pid + " (#"+worker.id+") has spawned", "green");
			});
			cluster.on('listening', function(worker, address) {
				//
			});
			cluster.on('exit', function(worker, code, signal) {
				binary.log("worker " + worker.process.pid + " (#"+worker.id+") has exited", "yellow");
				setTimeout(binary.reloadAWorker, 1000) // to prevent CPU-splsions if crashing too fast
			});

			binary.loopUntilAllWorkers();
		}
	});
	// try{
	// 	// var actionHeroPrototype = require("actionHero").actionHeroPrototype;
	// 	var execCMD = process.cwd() + "/node_modules/actionHero/bin/actionHero";
	// }catch(e){
	// 	var execCMD = process.cwd() + "/bin/actionHero";
	// }
}